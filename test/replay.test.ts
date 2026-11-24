import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { diffTraces } from "../src/diff.js";
import { replay } from "../src/engine.js";
import { enrichFromOverwatch } from "../src/overwatch.js";
import { ScriptedProvider } from "../src/provider.js";
import { UNREPLAYABLE_MESSAGE } from "../src/resolver.js";
import { runReplays } from "../src/run.js";
import { TraceStore } from "../src/trace.js";
import { CLI, fakeApi, recordedTrace, run, tempDir, text, toolUse, WEATHER_SERVER } from "./helpers.js";

const weather = (_: string, input: Record<string, unknown>) => `recorded: sunny in ${input.city}`;

function baseline() {
  return recordedTrace({
    task: "Weather in Paris and Rome?",
    turns: [
      [text("Checking."), toolUse("get_weather", { city: "Paris" })],
      [toolUse("get_weather", { city: "Rome" })],
      [text("Both are sunny.")],
    ],
    tools: weather,
  });
}

/** Tool results the candidate model was given, in order. */
function resultsSent(p: ScriptedProvider): unknown[] {
  return p.requests.flatMap((r) => {
    const last = (r.messages as Anthropic.MessageParam[]).at(-1);
    return Array.isArray(last?.content) ? last.content.filter((b) => b.type === "tool_result") : [];
  });
}

describe("replay engine", () => {
  it("answers the same calls from the recording and reports no divergence", async () => {
    const p = new ScriptedProvider([
      { content: [toolUse("get_weather", { city: "Paris" })] },
      { content: [toolUse("get_weather", { city: "Rome" })] },
      { content: [text("Both are sunny.")] },
    ]);
    const base = baseline();
    const cand = await replay(base, { model: "claude-haiku-5-5" }, { provider: p });
    expect(cand.status).toBe("complete");
    expect(cand.request.model).toBe("claude-haiku-5-5");
    expect(p.requests[0]).toMatchObject({
      model: "claude-haiku-5-5",
      system: "You are a test agent.",
      messages: [{ role: "user", content: "Weather in Paris and Rome?" }],
    });
    expect(resultsSent(p)).toEqual([
      { type: "tool_result", tool_use_id: expect.any(String), content: "recorded: sunny in Paris" },
      { type: "tool_result", tool_use_id: expect.any(String), content: "recorded: sunny in Rome" },
    ]);
    expect(cand.steps.map((s) => s.replay)).toEqual([
      { tier: "exact", matchedStep: 0 },
      { tier: "exact", matchedStep: 1 },
    ]);
    expect(cand.replay).toMatchObject({ baselineId: base.id, changes: { model: "claude-haiku-5-5" } });
    expect(diffTraces(base, cand).verdict).toBe("same");
  });

  it("reuses a close-enough recorded call (fuzzy) and labels it", async () => {
    const p = new ScriptedProvider([
      { content: [toolUse("get_weather", { city: "paris " })] },
      { content: [text("Paris is sunny.")] },
    ]);
    const cand = await replay(baseline(), {}, { provider: p });
    expect(cand.steps[0]?.replay).toMatchObject({ tier: "fuzzy", matchedStep: 0 });
    expect(resultsSent(p)[0]).toMatchObject({ content: "recorded: sunny in Paris" });
    const d = diffTraces(baseline(), cand);
    expect(d.verdict).toBe("changed");
    expect(d.firstDivergence?.kind).toBe("arguments");
  });

  it("stops and marks the run unreplayable when a call has no recording", async () => {
    const p = new ScriptedProvider([{ content: [toolUse("get_weather", { city: "Tokyo" })] }]);
    const cand = await replay(baseline(), {}, { provider: p });
    expect(cand.status).toBe("unreplayable");
    expect(cand.steps[0]).toMatchObject({
      isError: true,
      result: UNREPLAYABLE_MESSAGE,
      replay: { tier: "unreplayable" },
    });
    expect(diffTraces(baseline(), cand).verdict).toBe("unreplayable");
  });

  it("with onMiss: continue, tells the model the call failed and keeps going", async () => {
    const p = new ScriptedProvider([
      { content: [toolUse("search", { query: "x" })] },
      { content: [text("Gave up on search.")] },
    ]);
    const cand = await replay(baseline(), {}, { provider: p, config: parseConfig("replay: { onMiss: continue }") });
    expect(cand.status).toBe("complete");
    expect(resultsSent(p)[0]).toMatchObject({ is_error: true, content: UNREPLAYABLE_MESSAGE });
  });

  it("answers a read-only tool from a real MCP server when configured as live", async () => {
    const p = new ScriptedProvider([
      { content: [toolUse("mcp__weather__get_weather", { city: "Oslo" })] },
      { content: [text("Oslo is clear.")] },
    ]);
    const config = parseConfig(
      `servers:\n  weather: { command: ["${process.execPath}", "${WEATHER_SERVER}"] }\ntools:\n  mcp__weather__get_weather: { readOnly: true, live: weather }`,
    );
    const cand = await replay(baseline(), {}, { provider: p, config });
    expect(cand.status).toBe("complete");
    expect(cand.steps[0]?.replay).toEqual({ tier: "live" });
    expect(resultsSent(p)[0]).toMatchObject({ content: [{ type: "text", text: "live: 21C and clear in Oslo" }] });
  });

  it("simulates a result when simulation is on", async () => {
    const p = new ScriptedProvider([
      { content: [toolUse("get_weather", { city: "Lima" })] },
      { content: [text("Lima is foggy.")] },
    ]);
    const sim = new ScriptedProvider([{ model: "claude-haiku-5-5", content: [text("recorded: foggy in Lima")] }]);
    const cand = await replay(
      baseline(),
      {},
      { provider: p, simulator: sim, config: parseConfig("replay: { simulate: true }") },
    );
    expect(cand.steps[0]?.replay).toMatchObject({ tier: "simulated" });
    expect(resultsSent(p)[0]).toMatchObject({ content: "recorded: foggy in Lima" });
    const prompt = ((sim.requests[0]?.messages ?? []) as Anthropic.MessageParam[])[0]?.content as string;
    expect(prompt).toContain('"city":"Lima"');
    expect(prompt).toContain("recorded: sunny in Paris");
  });

  it("answers a repeated call with the recorded results in order, then reuses", async () => {
    const base = recordedTrace({
      task: "poll",
      turns: [[toolUse("search", { query: "status" })], [toolUse("search", { query: "status" })], [text("ok")]],
      tools: (() => {
        let n = 0;
        return () => `result ${++n}`;
      })(),
    });
    const p = new ScriptedProvider([
      { content: [toolUse("search", { query: "status" })] },
      { content: [toolUse("search", { query: "status" })] },
      { content: [toolUse("search", { query: "status" })] },
      { content: [text("ok")] },
    ]);
    const cand = await replay(base, {}, { provider: p });
    expect(resultsSent(p).map((r) => (r as { content: string }).content)).toEqual(["result 1", "result 2", "result 1"]);
    expect(cand.steps[2]?.replay).toMatchObject({ tier: "exact", reused: true });
    expect(diffTraces(base, cand).firstDivergence).toMatchObject({ kind: "extra_call" });
  });

  it("records an API error as an error run instead of throwing", async () => {
    const p = new ScriptedProvider([]);
    const cand = await replay(baseline(), {}, { provider: p });
    expect(cand.status).toBe("error");
    expect(cand.replay?.error).toContain("script exhausted");
    expect(diffTraces(baseline(), cand).verdict).toBe("error");
  });

  it("stops at maxTurns", async () => {
    const p = new ScriptedProvider(
      Array.from({ length: 5 }, () => ({ content: [toolUse("get_weather", { city: "Paris" })] })),
    );
    const cand = await replay(baseline(), {}, { provider: p, config: parseConfig("replay: { maxTurns: 3 }") });
    expect(cand.status).toBe("max_turns");
    expect(cand.exchanges).toHaveLength(3);
  });

  it("runs a batch and saves candidates, diffs and a summary", async () => {
    const tmp = tempDir();
    try {
      const store = new TraceStore(tmp.dir);
      const p = new ScriptedProvider([
        { content: [toolUse("get_weather", { city: "Paris" })] },
        { content: [toolUse("get_weather", { city: "Rome" })] },
        { content: [text("Both are sunny.")] },
      ]);
      const result = await runReplays({
        store,
        baselines: [baseline()],
        changes: { model: "claude-haiku-5-5" },
        provider: p,
        config: parseConfig(""),
      });
      expect(result.summary.verdicts.same).toBe(1);
      expect(result.summary.replayTiers).toEqual({ exact: 2 });
      const saved = new TraceStore(tmp.dir).load(join(result.dir, "candidates", `${result.candidates[0]?.id}.json`));
      expect(saved.source).toBe("replay");
    } finally {
      tmp.cleanup();
    }
  });
});

describe("AgentOverwatch import", () => {
  it("attaches server names and timings to matching tool calls", () => {
    const tmp = tempDir();
    try {
      const dbPath = join(tmp.dir, "ao.db");
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, server_name TEXT NOT NULL, started_at INTEGER NOT NULL);
        CREATE TABLE calls (id INTEGER PRIMARY KEY, session_id TEXT, method TEXT, tool_name TEXT, request_json TEXT, status TEXT, started_at INTEGER, duration_ms REAL);`);
      db.prepare("INSERT INTO sessions VALUES ('s1', 'weather-api', 0)").run();
      const ins = db.prepare(
        "INSERT INTO calls (session_id, method, tool_name, request_json, status, started_at, duration_ms) VALUES ('s1', 'tools/call', ?, ?, ?, ?, ?)",
      );
      ins.run("get_weather", JSON.stringify({ name: "get_weather", arguments: { city: "Paris" } }), "ok", 1_200, 12.5);
      ins.run(
        "get_weather",
        JSON.stringify({ name: "get_weather", arguments: { city: "Rome" } }),
        "blocked",
        1_300,
        0.4,
      );
      ins.run("get_weather", JSON.stringify({ name: "get_weather", arguments: { city: "Oslo" } }), "ok", 1_300, 3);
      db.close();
      const base = baseline();
      const r = enrichFromOverwatch([base], dbPath);
      expect(r).toMatchObject({ matched: 2, unmatched: 0 });
      expect(base.steps[0]).toMatchObject({ server: "weather-api", mcpLatencyMs: 12.5, isError: false });
      expect(base.steps[1]).toMatchObject({ server: "weather-api", isError: true });
    } finally {
      tmp.cleanup();
    }
  });
});

describe("tracewarp replay (CLI)", () => {
  it("replays recorded traces on another model and prints the diff and summary", async () => {
    const tmp = tempDir();
    const api = await fakeApi((body) => {
      const n = (body.messages as unknown[]).length;
      if (n === 1) return { content: [toolUse("get_weather", { city: "Paris" })] };
      if (n === 3) return { content: [toolUse("get_weather", { city: "Berlin" })] };
      return { content: [text("Paris sunny, Berlin unknown.")] };
    });
    try {
      const dir = join(tmp.dir, ".tw");
      const store = new TraceStore(dir);
      const base = baseline();
      store.save(base);
      const r = await run(
        process.execPath,
        [CLI, "--dir", dir, "replay", "--all", "--model", "claude-haiku-5-5", "--param", "max_tokens=321"],
        {
          env: { ...process.env, TRACEWARP_ANTHROPIC_API_KEY: "test", TRACEWARP_UPSTREAM: api.url, TRACEWARP_DIR: "" },
          cwd: tmp.dir,
        },
      );
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("UNREPLAYABLE");
      expect(r.stdout).toContain("get_weather → get_weather");
      expect(r.stdout).toContain("1 runs replayed");
      expect(api.bodies[0]).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 321, stream: true });
      const noKey = await run(process.execPath, [CLI, "--dir", dir, "replay", "--all"], {
        env: { ...process.env, TRACEWARP_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "" },
        cwd: tmp.dir,
      });
      expect(noKey.status).toBe(1);
      expect(noKey.stderr).toContain("TRACEWARP_ANTHROPIC_API_KEY");
      mkdirSync(join(tmp.dir, "cfg"));
      writeFileSync(join(tmp.dir, "cfg", "bad.yaml"), "replay: { onMiss: maybe }");
      const bad = await run(
        process.execPath,
        [CLI, "--dir", dir, "replay", "--all", "-c", join(tmp.dir, "cfg", "bad.yaml")],
        { cwd: tmp.dir },
      );
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("onMiss");
    } finally {
      await api.close();
      tmp.cleanup();
    }
  });
});
