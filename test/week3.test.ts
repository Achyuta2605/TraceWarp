import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeTools } from "../src/builtins.js";
import { parseConfig } from "../src/config.js";
import { diffTraces } from "../src/diff.js";
import { replay } from "../src/engine.js";
import { billedNote } from "../src/format.js";
import { cacheNeutralCostUsd, costUsd } from "../src/pricing.js";
import { ScriptedProvider } from "../src/provider.js";
import { TraceStore, taskText } from "../src/trace.js";
import { CLI, fakeApi, recordedTrace, run, tempDir, text, toolUse } from "./helpers.js";

let tmp: ReturnType<typeof tempDir>;
let root: string;
beforeEach(() => {
  tmp = tempDir();
  root = join(tmp.dir, "repo");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "a.md"), "# Alpha\nretry 3 times\nbackoff 200 ms\n");
  writeFileSync(join(root, "docs", "b.txt"), "nothing here\n");
  writeFileSync(join(root, "README.md"), "Ask #payments-oncall for the on-call lead.\n");
  writeFileSync(join(tmp.dir, "secret.txt"), "TOP SECRET\n");
});
afterEach(() => tmp.cleanup());

describe("built-in Claude Code read tools", () => {
  it("Read numbers lines like Claude Code and honours offset and limit", async () => {
    const t = new ClaudeCodeTools(root);
    expect(await t.call("Read", { file_path: join(root, "docs/a.md") })).toEqual({
      content: "1\t# Alpha\n2\tretry 3 times\n3\tbackoff 200 ms\n",
      isError: false,
    });
    expect((await t.call("Read", { file_path: "docs/a.md", offset: 2, limit: 1 })).content).toBe("2\tretry 3 times\n");
    expect(await t.call("Read", { file_path: "docs/missing.md" })).toEqual({
      content: "File does not exist.",
      isError: true,
    });
  });

  it("Grep lists matching files, shows content with line numbers and context, and counts", async () => {
    const t = new ClaudeCodeTools(root);
    expect((await t.call("Grep", { pattern: "RETRY|on-call", "-i": true })).content).toBe(
      "Found 2 files\nREADME.md\ndocs/a.md",
    );
    expect(
      (await t.call("Grep", { pattern: "(?i)backoff", output_mode: "content", "-B": 1, path: "docs" })).content,
    ).toBe("docs/a.md-2-retry 3 times\ndocs/a.md:3:backoff 200 ms");
    expect(
      (await t.call("Grep", { pattern: "e", output_mode: "count", glob: "*.{md,txt}", path: "docs" })).content,
    ).toBe("docs/a.md:1\ndocs/b.txt:1");
    expect((await t.call("Grep", { pattern: "zzz" })).content).toBe("No files found");
    expect((await t.call("Grep", { pattern: "(" })).isError).toBe(true);
  });

  it("Glob and LS list files inside the root", async () => {
    const t = new ClaudeCodeTools(root);
    expect((await t.call("Glob", { pattern: "**/*.md" })).content.split("\n").sort()).toEqual([
      "README.md",
      "docs/a.md",
    ]);
    expect((await t.call("Glob", { pattern: "*.py" })).content).toBe("No files found");
    expect((await t.call("LS", { path: "docs" })).content).toContain("  - a.md");
  });

  it("refuses paths outside the root, including through a symlink, and never offers write tools", async () => {
    symlinkSync(join(tmp.dir, "secret.txt"), join(root, "link.txt"));
    const t = new ClaudeCodeTools(root);
    for (const file_path of [join(tmp.dir, "secret.txt"), "../secret.txt", "link.txt"]) {
      const r = await t.call("Read", { file_path });
      expect(r.isError).toBe(true);
      expect(r.content).not.toContain("TOP SECRET");
    }
    expect((await t.call("Grep", { pattern: "SECRET", path: ".." })).isError).toBe(true);
    expect((await t.call("Grep", { pattern: "SECRET" })).content).toBe("No files found");
    expect(t.handles("Write")).toBe(false);
    expect(t.handles("Bash")).toBe(false);
  });

  it("maps absolute paths from the recorded folder onto the replay root", async () => {
    const t = new ClaudeCodeTools(root, "/home/someone/old-checkout");
    expect((await t.call("Read", { file_path: "/home/someone/old-checkout/docs/a.md", limit: 1 })).content).toBe(
      "1\t# Alpha\n",
    );
  });
});

describe("replaying a Claude Code session", () => {
  const ccTrace = () => {
    const t = recordedTrace({
      task: "How many retries?",
      turns: [[toolUse("Grep", { pattern: "retry" })], [text("We retry 3 times.")]],
      tools: () => "Found 1 file\ndocs/a.md",
    });
    t.request.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\nToday's date is 2026-11-24.\n</system-reminder>" },
          { type: "text", text: "How many retries?" },
          { type: "text", text: "<system-reminder>Use tools.</system-reminder>" },
        ],
      },
    ];
    return { ...t, cwd: root };
  };

  it("names the task without Claude Code's system reminders", () => {
    expect(taskText(ccTrace())).toBe("How many retries?");
  });

  it("answers an unrecorded Read from disk and a denied Bash with a permission error", async () => {
    const p = new ScriptedProvider([
      { content: [toolUse("Read", { file_path: join(root, "docs/a.md") }), toolUse("Bash", { command: "rm -rf /" })] },
      { content: [text("We retry 3 times.")] },
    ]);
    const config = parseConfig("builtins: { claudeCode: { enabled: true } }\ntools: { Bash: { deny: true } }");
    const cand = await replay(ccTrace(), {}, { provider: p, config });
    expect(cand.status).toBe("complete");
    expect(cand.cwd).toBe(root);
    expect(cand.steps.map((s) => s.replay?.tier)).toEqual(["live", "denied"]);
    expect(String(cand.steps[0]?.result)).toContain("2\tretry 3 times");
    expect(cand.steps[1]?.isError).toBe(true);
  });

  it("leaves Claude Code tools unreplayable when the built-ins are off", async () => {
    const p = new ScriptedProvider([{ content: [toolUse("Read", { file_path: "docs/a.md" })] }]);
    const cand = await replay(ccTrace(), {}, { provider: p, config: parseConfig("") });
    expect(cand.status).toBe("unreplayable");
  });

  it("rejects a tool that is both denied and live", () => {
    expect(() =>
      parseConfig("servers: { s: { command: [x] } }\ntools: { T: { deny: true, readOnly: true, live: s } }"),
    ).toThrow(/denied/);
  });
});

describe("diffs of parallel calls and cached prompts", () => {
  const files = (...paths: string[]) =>
    recordedTrace({
      task: "Read the docs",
      turns: [paths.map((p) => toolUse("Read", { file_path: p })), [text("Done: 3 retries.")]],
      tools: () => "ok",
    });

  it("does not count a reordered batch of parallel calls as a change", () => {
    const d = diffTraces(files("a.md", "b.md"), files("b.md", "a.md"));
    expect(d.verdict).toBe("same");
    expect(d.tools.argChanges).toEqual([]);
  });

  it("pairs identical calls around an extra one instead of shifting every pair", () => {
    const d = diffTraces(files("a.md", "c.md", "d.md"), files("a.md", "b.md", "c.md", "d.md"));
    expect(d.tools.added).toEqual(["Read"]);
    expect(d.tools.argChanges).toEqual([]);
  });

  it("compares cost without the prompt cache, and says what was billed", () => {
    const usage = { inputTokens: 10, outputTokens: 100, cacheReadTokens: 100_000, cacheWriteTokens: 0 };
    expect(cacheNeutralCostUsd("claude-sonnet-5-5", usage)).toBeCloseTo((100_010 * 2 + 100 * 10) / 1e6);
    expect(costUsd("claude-sonnet-5-5", usage)).toBeLessThan(cacheNeutralCostUsd("claude-sonnet-5-5", usage) ?? 0);
    expect(cacheNeutralCostUsd("not-a-model", usage)).toBeNull();
    expect(
      billedNote({ costUsd: { baseline: 0.3, candidate: 0.3 }, billedCostUsd: { baseline: 0.15, candidate: 0.03 } }),
    ).toContain("billed $0.150 → $0.030");
    expect(billedNote({ costUsd: { baseline: 1, candidate: 2 }, billedCostUsd: { baseline: 1, candidate: 2 } })).toBe(
      "",
    );
  });
});

describe("tracewarp replay for Claude Code (CLI)", () => {
  it("--agents-only skips side calls, --claude-code-tools reads the folder, --deny-tool denies", async () => {
    const api = await fakeApi((body) => {
      const n = (body.messages as unknown[]).length;
      if (!body.tools) return { content: [text("a title")] };
      return n === 1
        ? { content: [toolUse("Read", { file_path: join(root, "README.md") }), toolUse("Bash", { command: "ls" })] }
        : { content: [text("Ask #payments-oncall.")] };
    });
    try {
      const dir = join(tmp.dir, ".tw");
      const store = new TraceStore(dir);
      const agent = recordedTrace({
        task: "Who is on call?",
        turns: [[toolUse("Grep", { pattern: "on-call" })], [text("Ask #payments-oncall.")]],
        tools: () => "Found 1 file\nREADME.md",
      });
      agent.request.tools = [{ name: "Read" }, { name: "Grep" }, { name: "Bash" }];
      store.save({ ...agent, cwd: root });
      const side = recordedTrace({ task: "Write a title", turns: [[text("a title")]], tools: () => "" });
      delete side.request.tools;
      store.save(side);
      const env = { ...process.env, TRACEWARP_ANTHROPIC_API_KEY: "test", TRACEWARP_UPSTREAM: api.url };
      const r = await run(
        process.execPath,
        [CLI, "--dir", dir, "replay", "--all", "--agents-only", "--claude-code-tools", "--deny-tool", "Bash"],
        { env, cwd: tmp.dir },
      );
      expect(r.stderr).toContain("skipped 1 single calls with no tools");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("1 runs replayed");
      expect(r.stdout).toContain("live 1");
      expect(r.stdout).toContain("denied 1");
      const missing = await run(
        process.execPath,
        [CLI, "--dir", dir, "replay", "--all", "--claude-code-tools", join(tmp.dir, "nope")],
        { env, cwd: tmp.dir },
      );
      expect(missing.status).toBe(3);
    } finally {
      await api.close();
    }
  });
});

describe("Agent SDK sessions", () => {
  it("records tools a later call loaded on demand, and the folder the session says it works in", async () => {
    const { Recorder } = await import("../src/recorder.js");
    const { fakeMessage } = await import("../src/provider.js");
    const store = new TraceStore(join(tmp.dir, ".tw"));
    const rec = new Recorder({ store, source: "proxy", cwd: "/where/tracewarp/ran" });
    const search = toolUse("ToolSearch", { query: "select:owner" });
    const first = {
      model: "claude-sonnet-5-5",
      tools: [{ name: "ToolSearch" }],
      messages: [
        { role: "user", content: "Who owns refunds?" },
        { role: "system", content: [{ type: "text", text: " - Primary working directory: /agent/docs\n" }] },
      ],
    };
    rec.record({
      body: first,
      startedAt: 1,
      latencyMs: 1,
      response: fakeMessage({ content: [search], stop_reason: "tool_use" }),
    });
    const owner = { name: "mcp__owners__owner", description: "Owner of a service", input_schema: { type: "object" } };
    rec.record({
      body: {
        ...first,
        tools: [{ name: "ToolSearch" }, owner],
        messages: [
          ...first.messages,
          { role: "assistant", content: [search] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: search.id,
                content: [{ type: "tool_reference", tool_name: "mcp__owners__owner" }],
              },
            ],
          },
        ],
      },
      startedAt: 2,
      latencyMs: 1,
      response: fakeMessage({ content: [text("The ledger team.")] }),
    });
    const [t] = store.list();
    expect(t?.laterTools).toEqual([{ turn: 1, tool: owner }]);
    expect(t?.cwd).toBe("/agent/docs");
  });

  it("offers a deferred tool once the replayed tool search points at it", async () => {
    const owner = { name: "mcp__owners__owner", description: "Owner", input_schema: { type: "object" } };
    const base = recordedTrace({
      task: "Who owns refunds?",
      turns: [
        [toolUse("ToolSearch", { query: "select:owner" })],
        [toolUse("mcp__owners__owner", { service: "refunds" })],
        [text("The ledger team.")],
      ],
      tools: (name) => (name === "ToolSearch" ? "unused" : "Ledger team"),
    });
    // Tool search results are tool_reference blocks, not text.
    (base.steps[0] as { result: unknown }).result = [{ type: "tool_reference", tool_name: owner.name }];
    base.laterTools = [{ turn: 5, tool: owner }];
    const p = new ScriptedProvider([
      { content: [toolUse("ToolSearch", { query: "select:owner" })] },
      { content: [toolUse("mcp__owners__owner", { service: "refunds" })] },
      { content: [text("The ledger team.")] },
    ]);
    const cand = await replay(base, {}, { provider: p, config: parseConfig("") });
    const names = (i: number) => ((p.requests[i]?.tools ?? []) as { name: string }[]).map((t) => t.name);
    expect(names(0)).not.toContain(owner.name);
    expect(names(1)).toContain(owner.name);
    expect(cand.status).toBe("complete");

    const hidden = new ScriptedProvider([
      { content: [toolUse("ToolSearch", { query: "select:owner" })] },
      { content: [text("No owner tool.")] },
    ]);
    await replay(base, { removeTools: [owner.name] }, { provider: hidden, config: parseConfig("") });
    expect(((hidden.requests[1]?.tools ?? []) as { name: string }[]).map((t) => t.name)).not.toContain(owner.name);
  });

  it("keeps a recorded absolute path that is already inside the root", async () => {
    const t = new ClaudeCodeTools(join(root, "docs"), root);
    expect((await t.call("Read", { file_path: join(root, "docs", "a.md"), limit: 1 })).content).toBe("1\t# Alpha\n");
  });
});

describe("review fixes", () => {
  it("Glob cannot list files outside the root: no .., no absolute patterns, no symlinked folders", async () => {
    mkdirSync(join(tmp.dir, "outside"));
    writeFileSync(join(tmp.dir, "outside", "secret.txt"), "x");
    symlinkSync(join(tmp.dir, "outside"), join(root, "linkdir"));
    const t = new ClaudeCodeTools(root);
    for (const pattern of ["../**/*", "../../**/*", join(tmp.dir, "**/*")]) {
      const r = await t.call("Glob", { pattern });
      expect(r.isError).toBe(true);
      expect(r.content).not.toContain("secret");
    }
    expect((await t.call("Glob", { pattern: "linkdir/*" })).content).toBe("No files found");
    expect((await t.call("Glob", { pattern: "**/*" })).content).not.toContain("secret");
    expect((await t.call("Glob", { pattern: "*.md" })).content).toBe("README.md");
    expect((await t.call("Glob", { pattern: "docs/*.{md,txt}" })).content.split("\n").sort()).toEqual([
      "docs/a.md",
      "docs/b.txt",
    ]);
  });

  it("stops a Grep pattern that backtracks for ever instead of hanging the replay", async () => {
    writeFileSync(join(root, "docs", "evil.txt"), `${"a".repeat(40)}!\n`);
    const t = new ClaudeCodeTools(root);
    const started = Date.now();
    const r = await t.call("Grep", { pattern: "^(a+)+$", path: "docs/evil.txt" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("took longer");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it("multiline Grep shows only the lines a match covers", async () => {
    writeFileSync(join(root, "docs", "m.txt"), "one\nstart\nmiddle\nend\nlast\n");
    const t = new ClaudeCodeTools(root);
    const r = await t.call("Grep", { pattern: "start.*?end", multiline: true, output_mode: "content", path: "docs" });
    expect(r.content).toBe("docs/m.txt:2:start\ndocs/m.txt:3:middle\ndocs/m.txt:4:end");
  });

  it("reads a file whose name starts with .., and refuses a FIFO instead of blocking", async () => {
    writeFileSync(join(root, "..notes"), "hi\n");
    const t = new ClaudeCodeTools(root);
    expect((await t.call("Read", { file_path: "..notes" })).content).toBe("1\thi\n");
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [join(root, "pipe")]);
    expect(await t.call("Read", { file_path: "pipe" })).toEqual({
      content: "Path is not a regular file.",
      isError: true,
    });
  });

  it("finds the session folder only in system text, and Windows paths too", async () => {
    const { clientCwd } = await import("../src/recorder.js");
    const req = (messages: unknown[], system?: unknown) =>
      ({ model: "m", messages, ...(system ? { system } : {}) }) as Parameters<typeof clientCwd>[0];
    expect(clientCwd(req([{ role: "user", content: "Primary working directory: /" }]))).toBeUndefined();
    expect(clientCwd(req([], "env\n - Primary working directory: C:\\Users\\me\\repo\n"))).toBe("C:\\Users\\me\\repo");
    expect(clientCwd(req([{ role: "system", content: "Primary working directory: /srv/app</system-reminder>" }]))).toBe(
      "/srv/app",
    );
  });

  it("will not open the home folder to a replay unless a root is named", async () => {
    const { homedir } = await import("node:os");
    const base = recordedTrace({ task: "t", turns: [[toolUse("Read", { file_path: "x" })]], tools: () => "" });
    const p = new ScriptedProvider([{ content: [toolUse("Read", { file_path: ".ssh/id_rsa" })] }]);
    const cand = await replay(
      { ...base, cwd: homedir() },
      {},
      { provider: p, config: parseConfig("builtins: { claudeCode: { enabled: true } }") },
    );
    expect(cand.status).toBe("unreplayable");
    expect(cand.replay?.warnings.join(" ")).toContain("name a narrower one");
  });

  it("does not offer a deferred tool to a model that never searched for it", async () => {
    const owner = { name: "mcp__owners__owner", description: "Owner", input_schema: { type: "object" } };
    const base = recordedTrace({
      task: "Who owns refunds?",
      turns: [[toolUse("search", { q: "refunds" })], [text("The ledger team.")]],
      tools: () => "refunds doc",
    });
    base.laterTools = [{ turn: 1, tool: owner }];
    const p = new ScriptedProvider([
      { content: [toolUse("search", { q: "refunds" })] },
      { content: [text("No owner found.")] },
    ]);
    await replay(base, {}, { provider: p, config: parseConfig("") });
    expect(((p.requests[1]?.tools ?? []) as { name: string }[]).map((t) => t.name)).not.toContain(owner.name);
  });

  it("turns a tool_reference to a removed tool into a note, and does not warn about later tools", async () => {
    const owner = { name: "mcp__owners__owner", description: "Owner", input_schema: { type: "object" } };
    const base = recordedTrace({
      task: "Who owns refunds?",
      turns: [[toolUse("ToolSearch", { query: "owner" })], [text("The ledger team.")]],
      tools: () => "",
    });
    (base.steps[0] as { result: unknown }).result = [{ type: "tool_reference", tool_name: owner.name }];
    base.laterTools = [{ turn: 1, tool: owner }];
    const p = new ScriptedProvider([
      { content: [toolUse("ToolSearch", { query: "owner" })] },
      { content: [text("No owner tool.")] },
    ]);
    const cand = await replay(base, { removeTools: [owner.name] }, { provider: p, config: parseConfig("") });
    const sent = JSON.stringify(p.requests[1]?.messages);
    expect(sent).not.toContain('"tool_reference"');
    expect(sent).toContain("is not available");
    expect(cand.replay?.warnings.join(" ")).not.toContain("no tool named");
  });

  it("counts one changed read in a parallel batch as one argument change", () => {
    const batch = (...paths: string[]) =>
      recordedTrace({
        task: "Read",
        turns: [paths.map((p) => toolUse("Read", { file_path: p })), [text("ok")]],
        tools: () => "ok",
      });
    const d = diffTraces(batch("b.md", "a.md"), batch("b.md", "c.md"));
    expect(d.tools.argChanges).toHaveLength(1);
    expect(d.firstDivergence).toMatchObject({ kind: "arguments" });
    expect(String(d.firstDivergence?.baseline)).toContain("a.md");
  });
});
