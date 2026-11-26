import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
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
    expect(c.servers.fs?.command).toEqual(["npx", "-y", PRESET_VERSIONS.filesystem, root]);
    expect(c.servers.fs?.root).toBe(root);
    expect(c.tools.mcp__fs__read_text_file).toEqual({
      readOnly: true,
      live: "fs",
      mcpName: "read_text_file",
      noSimulate: false,
      deny: false,
    });
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

  it("lets the config override a preset's command and its tools", () => {
    const c = parseConfig(
      [
        "servers:",
        "  fs: { preset: filesystem, root: ., command: [mcp-server-filesystem, .] }",
        "tools:",
        "  mcp__fs__read_media_file: { deny: true }",
        "  mcp__fs__directory_tree: { readOnly: true }",
      ].join("\n"),
    );
    expect(c.servers.fs?.command).toEqual(["mcp-server-filesystem", "."]);
    expect(c.tools.mcp__fs__read_media_file).toMatchObject({ deny: true, readOnly: false });
    expect(c.tools.mcp__fs__directory_tree?.live).toBeUndefined();
    expect(c.tools.mcp__fs__read_file?.live).toBe("fs");
  });

  it("explains a preset that is missing its root, or settings that need a preset", () => {
    expectProblem("servers:\n  fs: { preset: filesystem }\n", "servers.fs.root: the filesystem preset needs a root");
    expectProblem("servers:\n  web: { preset: fetch, root: . }\n", "the fetch preset takes no root");
    expectProblem("servers:\n  x: { preset: sqlite, root: . }\n", "servers.x.preset");
    expectProblem("servers:\n  x: { env: { A: b } }\n", "servers.x.command: give a command or a preset");
    expectProblem("servers:\n  x: { command: [a], root: . }\n", "root needs a preset");
    expectProblem("servers:\n  x: { command: [a], openWorld: true }\n", "openWorld needs a preset");
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

  const config = () =>
    parseConfig(`servers:\n  fs: { preset: filesystem, root: ${docs}, command: [${FS_BIN}, ${docs}] }\n`);

  it.runIf(existsSync(FS_BIN))(
    "answers a new read for real, refuses paths outside the root, and never runs a write",
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
        expect(outside?.replay?.tier).toBe("live");
        expect(outside?.isError).toBe(true);
        expect(JSON.stringify(outside?.result)).toContain("outside allowed directories");
        expect(link?.isError).toBe(true);
        expect(JSON.stringify(link?.result)).not.toContain("outside the root\\n");
        expect(write?.replay?.tier).toBe("unreplayable");
        expect(existsSync(join(docs, "new.md"))).toBe(false);
      } finally {
        await live.close();
      }
    },
    30_000,
  );

  it("says what to install when a preset server cannot start", async () => {
    const c = parseConfig("servers:\n  git: { preset: git, root: ., command: [tracewarp-no-such-uvx, x] }\n");
    const live = new LiveTools(c.servers);
    try {
      await expect(live.call("git", "git_status", {})).rejects.toThrow(
        /could not start server "git": .*ENOENT.*the git preset needs uv/,
      );
    } finally {
      await live.close();
    }
  });
});
