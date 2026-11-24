import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";

/**
 * Claude Code's read-only file tools (Read, Grep, Glob, LS), run for real against a folder on disk. A replay of a
 * Claude Code session uses them to answer reads the recording never saw, the way an MCP server does for `live`
 * tools. They never write, and they refuse any path outside the root.
 *
 * These are reimplementations that follow Claude Code's output formats closely, not Claude Code itself, so a
 * result can differ from the real tool in small ways (sort order, how a regex edge case is read).
 */

export const CLAUDE_CODE_READ_TOOLS = ["Read", "Grep", "Glob", "LS"] as const;

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_GLOB_RESULTS = 100;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".tracewarp"]);
/** A model writes the Grep pattern, so it runs in a worker that is stopped after this long (catastrophic regexes). */
const GREP_TIMEOUT_MS = 5000;
const MAX_GREP_BYTES = 64 * 1024 * 1024;

export interface BuiltinResult {
  content: string;
  isError: boolean;
}

export class ClaudeCodeTools {
  private readonly root: string;

  /**
   * @param root folder the tools may read
   * @param recordedCwd folder the session ran in when it was recorded; absolute paths under it are mapped to root
   */
  constructor(
    root: string,
    private readonly recordedCwd?: string,
  ) {
    this.root = realpathSync(resolve(root));
  }

  handles(name: string): boolean {
    return (CLAUDE_CODE_READ_TOOLS as readonly string[]).includes(name);
  }

  async call(name: string, input: unknown): Promise<BuiltinResult> {
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "Read":
          return this.read(args);
        case "Grep":
          return await this.grep(args);
        case "Glob":
          return this.glob(args);
        case "LS":
          return this.ls(args);
        default:
          return err(`${name} is not a built-in read-only tool`);
      }
    } catch (e) {
      if (e instanceof OutsideRoot) return err(e.message);
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return err("File does not exist.");
      if (code === "EISDIR") return err("Path is a directory, not a file.");
      return err((e as Error).message);
    }
  }

  /** Resolves a path the model gave, inside the root. Recorded absolute paths are moved to the root. */
  private path(p: unknown, fallback = "."): string {
    let raw = typeof p === "string" && p.length ? p : fallback;
    // A recorded absolute path is kept when it is already inside the root, and moved there when it is under the
    // folder the session was recorded in (a replay on another checkout).
    if (this.recordedCwd && isAbsolute(raw) && !within(this.root, raw) && within(this.recordedCwd, raw)) {
      raw = join(this.root, relative(this.recordedCwd, raw));
    }
    const full = resolve(this.root, raw);
    // realpath, so a symlink inside the root cannot point the tools outside it.
    let real: string;
    try {
      real = realpathSync(full);
    } catch (e) {
      if (!within(this.root, full)) throw new OutsideRoot(raw);
      throw e;
    }
    if (!within(this.root, real)) throw new OutsideRoot(raw);
    return real;
  }

  private read(a: Record<string, unknown>): BuiltinResult {
    if (typeof a.file_path !== "string") return err("file_path is required");
    const file = this.path(a.file_path);
    const st = statSync(file);
    if (st.isDirectory()) return err("Path is a directory, not a file.");
    // Not a FIFO or device: reading one would block forever.
    if (!st.isFile()) return err("Path is not a regular file.");
    if (st.size > MAX_FILE_BYTES) return err(`File is too large to read (${st.size} bytes).`);
    const lines = readFileSync(file, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const offset = Math.max(1, num(a.offset) ?? 1);
    const limit = Math.max(1, num(a.limit) ?? MAX_READ_LINES);
    const out = lines
      .slice(offset - 1, offset - 1 + limit)
      .map((l, i) => `${offset + i}\t${l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l}`);
    if (!out.length) return ok(lines.length ? "(no lines at this offset)" : "(file is empty)");
    return ok(`${out.join("\n")}\n`);
  }

  private glob(a: Record<string, unknown>): BuiltinResult {
    if (typeof a.pattern !== "string") return err("pattern is required");
    const pattern = a.pattern;
    // Patterns are matched against files found by walking the root (no symlinks followed), so they cannot reach
    // outside it; an absolute or ".." pattern is refused rather than silently matching nothing.
    if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) throw new OutsideRoot(pattern);
    const base = this.path(a.path);
    const globs = expandBraces(pattern);
    const hits = walk(this.root, base)
      .filter((f) => globs.some((g) => matchGlob(g, relative(base, f), true)))
      .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
      .sort((x, y) => y.mtime - x.mtime || (x.p < y.p ? -1 : x.p > y.p ? 1 : 0));
    if (!hits.length) return ok("No files found");
    const shown = hits.slice(0, MAX_GLOB_RESULTS).map((h) => relative(this.root, h.p));
    const more =
      hits.length > MAX_GLOB_RESULTS ? "\n(Results are truncated. Use a more specific path or pattern.)" : "";
    return ok(shown.join("\n") + more);
  }

  private async grep(a: Record<string, unknown>): Promise<BuiltinResult> {
    if (typeof a.pattern !== "string") return err("pattern is required");
    let pattern = a.pattern;
    let flags = a["-i"] === true ? "i" : "";
    // Ripgrep accepts an inline (?i); JavaScript does not.
    if (pattern.startsWith("(?i)")) {
      pattern = pattern.slice(4);
      if (!flags.includes("i")) flags += "i";
    }
    const multiline = a.multiline === true;
    if (multiline) flags += "s";
    try {
      new RegExp(pattern, flags);
    } catch (e) {
      return err(`invalid regex: ${(e as Error).message}`);
    }
    const mode = typeof a.output_mode === "string" ? a.output_mode : "files_with_matches";
    const target = this.path(a.path);
    const files: { rel: string; text: string }[] = [];
    let bytes = 0;
    for (const f of isFile(target) ? [target] : walk(this.root, target)) {
      if (!matchesFilter(f, a)) continue;
      const text = readText(f);
      if (text === null) continue;
      bytes += text.length;
      if (bytes > MAX_GREP_BYTES) return err("Too much text to search; narrow the path or glob.");
      files.push({ rel: relative(this.root, f), text });
    }
    let found: Array<Array<[number, number]>>;
    try {
      found = await matchInWorker(pattern, flags, multiline, files);
    } catch (e) {
      return err((e as Error).message);
    }
    const before = num(a["-B"]) ?? num(a["-C"]) ?? num(a.context) ?? 0;
    const after = num(a["-A"]) ?? num(a["-C"]) ?? num(a.context) ?? 0;
    const lineNumbers = a["-n"] !== false;
    const headLimit = num(a.head_limit);
    const skip = num(a.offset) ?? 0;

    const matched: string[] = [];
    const counts: string[] = [];
    const lines: string[] = [];
    files.forEach(({ rel, text }, n) => {
      const spans = found[n] ?? [];
      if (!spans.length) return;
      matched.push(rel);
      counts.push(`${rel}:${spans.length}`);
      if (mode !== "content") return;
      const fileLines = text.split("\n");
      const hits = new Set<number>();
      for (const [s0, e0] of spans) for (let k = s0; k <= e0; k++) hits.add(k);
      const show = new Set<number>();
      for (const [s0, e0] of spans) {
        for (let k = Math.max(0, s0 - before); k <= Math.min(fileLines.length - 1, e0 + after); k++) show.add(k);
      }
      for (const k of [...show].sort((x, y) => x - y)) {
        const sepChar = hits.has(k) ? ":" : "-";
        lines.push(
          lineNumbers ? `${rel}${sepChar}${k + 1}${sepChar}${fileLines[k]}` : `${rel}${sepChar}${fileLines[k]}`,
        );
      }
    });
    const page = <T>(xs: T[]) => xs.slice(skip, headLimit ? skip + headLimit : undefined);
    if (mode === "content") return ok(lines.length ? page(lines).join("\n") : "No matches found");
    if (mode === "count") return ok(counts.length ? page(counts).join("\n") : "No matches found");
    if (!matched.length) return ok("No files found");
    const shown = page(matched);
    return ok(`Found ${matched.length} file${matched.length === 1 ? "" : "s"}\n${shown.join("\n")}`);
  }

  private ls(a: Record<string, unknown>): BuiltinResult {
    const dir = this.path(a.path);
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !SKIP_DIRS.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return ok(`- ${dir}${sep}\n${entries.map((e) => `  - ${e}`).join("\n")}`);
  }
}

class OutsideRoot extends Error {
  constructor(p: string) {
    super(`TraceWarp: ${p} is outside the folder this replay may read.`);
  }
}

function ok(content: string): BuiltinResult {
  return { content, isError: false };
}
function err(content: string): BuiltinResult {
  return { content, isError: true };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;
}

function within(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

// Runs in a worker thread, so a pattern that backtracks for ever can be stopped. Returns, per file, the line
// span [first, last] of each match (one line each unless multiline).
const MATCH_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { pattern, flags, multiline, files } = workerData;
const out = files.map(({ text }) => {
  if (!multiline) {
    const re = new RegExp(pattern, flags);
    const spans = [];
    text.split("\\n").forEach((line, i) => { if (re.test(line)) spans.push([i, i]); });
    return spans;
  }
  const g = new RegExp(pattern, flags + "g");
  const spans = [];
  let m;
  while ((m = g.exec(text))) {
    const start = text.slice(0, m.index).split("\\n").length - 1;
    spans.push([start, start + m[0].split("\\n").length - 1]);
    if (m[0].length === 0) g.lastIndex++;
  }
  return spans;
});
parentPort.postMessage(out);
`;

function matchInWorker(
  pattern: string,
  flags: string,
  multiline: boolean,
  files: { text: string }[],
): Promise<Array<Array<[number, number]>>> {
  if (!files.length) return Promise.resolve([]);
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(MATCH_WORKER, { eval: true, workerData: { pattern, flags, multiline, files } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`The pattern took longer than ${GREP_TIMEOUT_MS / 1000} s to run, so TraceWarp stopped it.`));
    }, GREP_TIMEOUT_MS);
    worker.once("message", (m: Array<Array<[number, number]>>) => {
      clearTimeout(timer);
      void worker.terminate();
      resolvePromise(m);
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function walk(root: string, dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(d, e.name);
      // Symlinks are not followed, so a walk cannot leave the root.
      if (e.isDirectory()) visit(full);
      else if (e.isFile()) out.push(full);
    }
  };
  if (within(root, dir)) visit(dir);
  return out;
}

const TYPE_EXT: Record<string, string[]> = {
  js: [".js", ".mjs", ".cjs", ".jsx"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py"],
  md: [".md", ".markdown"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  go: [".go"],
  rust: [".rs"],
  java: [".java"],
};

function matchesFilter(file: string, a: Record<string, unknown>): boolean {
  if (typeof a.type === "string") {
    const exts = TYPE_EXT[a.type] ?? [`.${a.type}`];
    if (!exts.some((e) => file.endsWith(e))) return false;
  }
  if (typeof a.glob === "string") {
    const name = file.split(sep).pop() ?? file;
    const globs = expandBraces(a.glob);
    if (!globs.some((g) => (g.includes("/") ? matchGlob(g, file) : matchGlob(g, name)))) return false;
  }
  return true;
}

function expandBraces(g: string): string[] {
  const m = /\{([^{}]*)\}/.exec(g);
  if (!m) return [g];
  return (m[1] as string).split(",").flatMap((alt) => expandBraces(g.replace(m[0], alt)));
}

function matchGlob(glob: string, path: string, anchored = false): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches any number of folders, including none; a bare "**" matches anything.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  return new RegExp(`${anchored ? "^" : "(^|/)"}${re}$`).test(path.split(sep).join("/"));
}

function readText(file: string): string | null {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return null;
    const buf = readFileSync(file);
    // Skip binary files, as ripgrep does.
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}
