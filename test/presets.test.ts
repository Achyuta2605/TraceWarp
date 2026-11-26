import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, denyTool, parseConfig } from "../src/config.js";
import { replay } from "../src/engine.js";
import { LiveTools } from "../src/live.js";
import { PRESET_VERSIONS, PRESETS } from "../src/presets.js";
import { ScriptedProvider } from "../src/provider.js";
import { recordedTrace, tempDir, text, toolUse } from "./helpers.js";

const FS_BIN = resolve("node_modules/.bin/mcp-server-filesystem");

function expectProblem(yaml: string, message: string) {
  expect(() => parseConfig(yaml)).toThrow(ConfigError);
  expect(() => parseConfig(yaml)).toThrow(message);
}

describe("server presets in tracewarp.yaml", () => {
  it("starts the pinned filesystem server in the root and makes only its read tools live", () => {
    const c = parseConfig("servers:\n  fs: { preset: filesystem, root: ./docs }\n");
    const root = resolve("docs");
    expect(c.servers.fs?.command).toEqual(["npx", "-y", PRESET_VERSIONS.filesystem, "--read-only", "--", root]);
    expect(c.servers.fs?.root).toBe(root);
    expect(c.tools.mcp__fs__read_text_file).toEqual({
      readOnly: true,
      live: "fs",
      mcpName: "read_text_file",
      noSimulate: false,
      deny: false,
    });
    expect(c.presetTools).toContain("mcp__fs__read_text_file");
    for (const write of ["write_file", "edit_file", "move_file", "create_directory", "append_file", "copy_file"]) {
      expect(c.tools[`mcp__fs__${write}`]).toBeUndefined();
    }
    expect(Object.keys(c.tools)).toHaveLength(PRESETS.filesystem.readTools.length);
  });

  it("confines the git server with --repository and leaves out commit, add, reset, checkout and merge", () => {
    const c = parseConfig("servers:\n  git: { preset: git, root: . }\n");
    expect(c.servers.git?.command).toEqual(["uvx", PRESET_VERSIONS.git, "--repository", resolve(".")]);
    expect(c.tools.mcp__git__git_log?.live).toBe("git");
    for (const write of ["git_commit", "git_add", "git_reset", "git_create_branch", "git_checkout", "git_merge"]) {
      expect(c.tools[`mcp__git__${write}`]).toBeUndefined();
    }
  });

  it("keeps fetch on recorded answers unless openWorld is on", () => {
    expect(parseConfig("servers:\n  web: { preset: fetch }\n").tools).toEqual({});
    const open = parseConfig("servers:\n  web: { preset: fetch, openWorld: true }\n");
    expect(open.tools.mcp__web__fetch).toMatchObject({ readOnly: true, live: "web", mcpName: "fetch" });
  });

  it("names tools with a custom prefix for agents that do not use mcp__<server>__", () => {
    const c = parseConfig('servers:\n  fs: { preset: filesystem, root: ., toolPrefix: "" }\n');
    expect(c.tools.read_text_file).toMatchObject({ live: "fs", mcpName: "read_text_file" });
    expect(c.tools.mcp__fs__read_text_file).toBeUndefined();
  });

  it("lets the config override a preset's command, and merges its own tool settings over the preset's", () => {
    const c = parseConfig(
      [
        "servers:",
        "  fs: { preset: filesystem, root: ., command: [mcp-server-filesystem, .] }",
        "tools:",
        "  mcp__fs__read_media_file: { deny: true }",
        "  mcp__fs__directory_tree: { readOnly: false }",
        "  mcp__fs__read_file: { noSimulate: true }",
      ].join("\n"),
    );
    expect(c.servers.fs?.command).toEqual(["mcp-server-filesystem", "."]);
    expect(c.tools.mcp__fs__read_media_file).toMatchObject({ deny: true, readOnly: false });
    expect(c.tools.mcp__fs__read_media_file?.live).toBeUndefined();
    expect(c.tools.mcp__fs__directory_tree?.live).toBeUndefined();
    expect(c.tools.mcp__fs__read_file).toMatchObject({ noSimulate: true, readOnly: true, live: "fs" });
    expect(c.tools.mcp__fs__get_file_info?.live).toBe("fs");
  });

  it("refuses to make a preset's write tool live, even when the config calls it read-only", () => {
    expectProblem(
      "servers:\n  fs: { preset: filesystem, root: . }\ntools:\n  mcp__fs__write_file: { readOnly: true, live: fs }\n",
      "write_file changes things, so it can never be live",
    );
    expectProblem(
      "servers:\n  git: { preset: git, root: . }\ntools:\n  mcp__git__git_commit: { readOnly: true, live: git }\n",
      "git_commit changes things",
    );
  });

  it("refuses two presets whose tools would share names", () => {
    expectProblem(
      'servers:\n  a: { preset: filesystem, root: ., toolPrefix: "" }\n  b: { preset: filesystem, root: ., toolPrefix: "" }\n',
      'read_file would belong to both "a" and "b"',
    );
  });

  it("expands ~ in a root and maps a hand-written tool through a custom prefix", () => {
    const c = parseConfig(
      'servers:\n  fs: { preset: filesystem, root: ~/docs, toolPrefix: "fs_" }\ntools:\n  fs_extra: { readOnly: true, live: fs }\n',
    );
    expect(c.servers.fs?.root).toBe(join(homedir(), "docs"));
    expect(c.tools.fs_extra?.mcpName).toBe("extra");
    expect(c.tools.fs_read_file?.mcpName).toBe("read_file");
  });

  it("explains a preset that is missing its root, or settings that need a preset", () => {
    expectProblem("servers:\n  fs: { preset: filesystem }\n", "servers.fs.root: the filesystem preset needs a root");
    expectProblem("servers:\n  web: { preset: fetch, root: . }\n", "the fetch preset takes no root");
    expectProblem("servers:\n  x: { preset: sqlite, root: . }\n", "servers.x.preset");
    expectProblem("servers:\n  x: { env: { A: b } }\n", "servers.x.command: give a command or a preset");
    expectProblem("servers:\n  x: { command: [a], root: . }\n", "root needs a preset");
    expectProblem("servers:\n  x: { command: [a], openWorld: true }\n", "openWorld needs a preset");
    expectProblem("servers:\n  fs: { preset: filesystem, root: ., openWorld: true }\n", "has no internet tools");
  });

  it("lets --deny-tool deny a preset tool, but not a tool the user made live by hand", () => {
    const c = parseConfig(
      "servers:\n  fs: { preset: filesystem, root: . }\n  docs: { command: [x] }\ntools:\n  search: { readOnly: true, live: docs }\n",
    );
    denyTool(c, "mcp__fs__read_media_file");
    expect(c.tools.mcp__fs__read_media_file).toEqual({ readOnly: false, deny: true, noSimulate: false });
    expect(() => denyTool(c, "search")).toThrow("the config makes this tool live");
    denyTool(c, "Bash");
    expect(c.tools.Bash).toMatchObject({ deny: true, readOnly: false });
  });

  it("still requires a live tool's server to exist", () => {
    expectProblem("tools:\n  t: { readOnly: true, live: nope }\n", 'no server named "nope"');
  });
});

describe("the filesystem preset against the real server", () => {
  let tmp: ReturnType<typeof tempDir>;
  let docs: string;
  beforeEach(() => {
    tmp = tempDir();
    docs = join(tmp.dir, "docs");
    mkdirSync(join(docs, "runbooks"), { recursive: true });
    writeFileSync(join(docs, "runbooks", "refund-failures.md"), "R-500: ledger write failed. Do NOT retry.\n");
    writeFileSync(join(tmp.dir, "secret.txt"), "outside the root\n");
    symlinkSync(join(tmp.dir, "secret.txt"), join(docs, "link.txt"));
  });
  afterEach(() => tmp.cleanup());

  const q = JSON.stringify;
  const config = () =>
    parseConfig(
      `servers:\n  fs: { preset: filesystem, root: ${q(docs)}, command: [${q(FS_BIN)}, --read-only, --, ${q(docs)}] }\n`,
    );

  it.runIf(existsSync(FS_BIN))(
    "answers a new read for real, keeps paths outside the root away from the model, and never runs a write",
    async () => {
      const base = recordedTrace({
        task: "What is R-500?",
        turns: [[toolUse("mcp__fs__list_directory", { path: docs })], [text("See the runbook.")]],
        tools: () => "[DIR] runbooks",
      });
      const p = new ScriptedProvider([
        { content: [toolUse("mcp__fs__read_text_file", { path: join(docs, "runbooks", "refund-failures.md") })] },
        { content: [toolUse("mcp__fs__read_text_file", { path: join(tmp.dir, "secret.txt") })] },
        { content: [toolUse("mcp__fs__read_text_file", { path: join(docs, "link.txt") })] },
        { content: [toolUse("mcp__fs__write_file", { path: join(docs, "new.md"), content: "x" })] },
        { content: [text("R-500 means the ledger write failed.")] },
      ]);
      const live = new LiveTools(config().servers);
      try {
        const cand = await replay(
          base,
          {},
          { provider: p, config: { ...config(), replay: { ...config().replay, onMiss: "continue" } }, live },
        );
        const [read, outside, link, write] = cand.steps;
        expect(read?.replay).toEqual({ tier: "live" });
        expect(JSON.stringify(read?.result)).toContain("Do NOT retry");
        // The server refuses both; TraceWarp treats that as a replay-setup miss, not an answer for the model.
        expect(outside?.replay?.tier).toBe("unreplayable");
        expect(outside?.replay?.note).toContain("refused a path outside its root");
        expect(link?.replay?.tier).toBe("unreplayable");
        expect(JSON.stringify(link?.result)).not.toContain("outside the root");
        expect(write?.replay?.tier).toBe("unreplayable");
        expect(existsSync(join(docs, "new.md"))).toBe(false);
      } finally {
        await live.close();
      }
    },
    30_000,
  );

  it("passes on why a server would not start", async () => {
    const c = parseConfig(
      `servers:\n  fs: { preset: filesystem, root: ., command: [${q(FS_BIN)}, ${q(join(tmp.dir, "nope"))}] }\n`,
    );
    const live = new LiveTools(c.servers);
    try {
      await expect(live.call("fs", "list_allowed_directories", {})).rejects.toThrow(/the server said: .+/);
    } finally {
      await live.close();
    }
  }, 20_000);

  it("says what to install only when the preset's own launcher is missing", async () => {
    const c = parseConfig("servers:\n  git: { preset: git, root: ., command: [tracewarp-no-such-uvx, x] }\n");
    const live = new LiveTools(c.servers);
    try {
      await expect(live.call("git", "git_status", {})).rejects.not.toThrow("needs uv");
      await expect(live.call("git", "git_status", {})).rejects.toThrow(/could not start server "git": .*ENOENT/);
    } finally {
      await live.close();
    }
  });
});

// Opt-in: needs mcp-server-git installed (TRACEWARP_TEST_GIT_SERVER=/path/to/mcp-server-git).
const GIT_BIN = process.env.TRACEWARP_TEST_GIT_SERVER;
describe.runIf(GIT_BIN)("the git preset against the real server", () => {
  it("answers git_log live and keeps other repositories and --output= away", async () => {
    const tmp = tempDir();
    const repo = join(tmp.dir, "repo");
    mkdirSync(repo);
    const sh = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    sh(["init", "-q"]);
    writeFileSync(join(repo, "a.md"), "retries: 3\n");
    sh(["add", "a.md"]);
    sh(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "Cut retries to 3"]);
    const q = JSON.stringify;
    const c = parseConfig(
      `servers:\n  git: { preset: git, root: ${q(repo)}, command: [${q(GIT_BIN)}, --repository, ${q(repo)}] }\n`,
    );
    const live = new LiveTools(c.servers);
    try {
      const log = await live.call("git", "git_log", { repo_path: repo, max_count: 5 });
      expect(log.isError).toBe(false);
      expect(JSON.stringify(log.content)).toContain("Cut retries to 3");
      const other = await live.call("git", "git_status", { repo_path: tmp.dir });
      expect(other.isError).toBe(true);
      const out = join(tmp.dir, "pwn");
      const inj = await live.call("git", "git_diff", { repo_path: repo, target: `--output=${out}` });
      expect(inj.isError).toBe(true);
      expect(existsSync(out)).toBe(false);
    } finally {
      await live.close();
      tmp.cleanup();
    }
  }, 30_000);
});
