import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultUpstream, startRecordingProxy } from "../src/capture.js";
import { parseConfig } from "../src/config.js";
import { diffTraces, summarize } from "../src/diff.js";
import { candidateRequest, mergeParams, replay, toResultContent } from "../src/engine.js";
import { inputSimilarity, isIdentifier } from "../src/json.js";
import { priceFor } from "../src/pricing.js";
import { AnthropicProvider, fakeMessage, type Provider, ScriptedProvider } from "../src/provider.js";
import { Recorder } from "../src/recorder.js";
import { runReplays } from "../src/run.js";
import { messageFromSse } from "../src/sse.js";
import { parseTrace, TraceFormatError, TraceStore } from "../src/trace.js";
import { CLI, fakeApi, recordedTrace, run, tempDir, text, toolUse, WEATHER_SERVER } from "./helpers.js";

/**
 * One test (or more) per finding of the week 1 code review, so each fix stays fixed.
 */

const weather = (_: string, input: Record<string, unknown>) => `recorded: sunny in ${input.city}`;

function baseline(id?: string) {
  return recordedTrace({
    task: "Weather in Paris and Rome?",
    turns: [
      [text("Checking."), toolUse("get_weather", { city: "Paris" })],
      [toolUse("get_weather", { city: "Rome" })],
      [text("Both are sunny.")],
    ],
    tools: weather,
    ...(id ? { id } : {}),
  });
}

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

describe("recording keeps what a replay needs, and keeps agents apart", () => {
  it("stores the anthropic-beta header and a replay sends it again", async () => {
    const store = new TraceStore(tmp.dir);
    const rec = new Recorder({ store, source: "sdk" });
    rec.record({
      body: { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
      headers: { "anthropic-beta": "context-1m-2025-08-07" },
      response: fakeMessage({ content: [text("hello")] }),
      startedAt: 1,
      latencyMs: 1,
    });
    const [t] = store.list();
    expect(t?.headers).toEqual({ "anthropic-beta": "context-1m-2025-08-07" });
    const p = new ScriptedProvider([{ content: [text("hello")] }]);
    await replay(t as NonNullable<typeof t>, {}, { provider: p });
    expect(p.headers[0]).toEqual({ "anthropic-beta": "context-1m-2025-08-07" });
  });

  it("the proxy keeps beta headers but never the API key", async () => {
    const api = await fakeApi(() => ({ content: [text("ok")] }));
    const store = new TraceStore(tmp.dir);
    const proxy = await startRecordingProxy(new Recorder({ store, source: "proxy" }), { upstream: api.url });
    try {
      const res = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "secret", "anthropic-beta": "b1" },
        body: JSON.stringify({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] }),
      });
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      await proxy.close();
      await api.close();
    }
    const [t] = store.list();
    expect(t?.headers).toEqual({ "anthropic-beta": "b1" });
    expect(JSON.stringify(t)).not.toContain("secret");
  });

  it("does not merge two agents that start with the same message", () => {
    const store = new TraceStore(tmp.dir);
    const rec = new Recorder({ store, source: "sdk" });
    const first: Anthropic.MessageParam[] = [{ role: "user", content: "Summarise the docs" }];
    const useA = toolUse("read_file", { path: "a.md" });
    rec.record({
      body: { model: "m", system: "agent A", max_tokens: 10, messages: first },
      response: fakeMessage({ content: [useA] }),
      startedAt: 1,
      latencyMs: 1,
    });
    // Agent B resends agent A's history prefix (same first message) plus a plain follow-up, under its own system.
    rec.record({
      body: {
        model: "m",
        system: "agent B",
        max_tokens: 10,
        messages: [...first, { role: "assistant", content: [useA] }, { role: "user", content: "and?" }],
      },
      response: fakeMessage({ content: [text("B done")] }),
      startedAt: 2,
      latencyMs: 1,
    });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.request.system).toBe("agent B");
    expect(rec.openTraces).toBe(1);
  });
});

describe("fuzzy matching never confuses identifiers", () => {
  it("numbers and ids must match exactly; prose may differ", () => {
    expect(inputSimilarity({ order: 1001 }, { order: 1002 })).toBe(0);
    expect(inputSimilarity({ id: "R-500" }, { id: "R-501" })).toBe(0);
    expect(inputSimilarity({ path: "runbooks/a.md" }, { path: "runbooks/b.md" })).toBe(0);
    expect(inputSimilarity({ path: "./src/app.ts" }, { path: "src/app.ts" })).toBe(1);
    expect(inputSimilarity({ q: "refund failures runbook" }, { q: "refund failure runbook" })).toBeGreaterThan(0.9);
    expect(isIdentifier("2026-11-24")).toBe(true);
    expect(isIdentifier("paris")).toBe(false);
  });

  it("a live read-only tool is called for real rather than answered by a merely similar recording", async () => {
    const base = recordedTrace({
      task: "Weather?",
      turns: [[toolUse("mcp__weather__get_weather", { city: "oslo" })], [text("Done.")]],
      tools: weather,
    });
    const p = new ScriptedProvider([
      { content: [toolUse("mcp__weather__get_weather", { city: "Oslo" })] },
      { content: [text("Oslo is clear.")] },
    ]);
    const config = parseConfig(
      `servers:\n  weather: { command: ["${process.execPath}", "${WEATHER_SERVER}"] }\ntools:\n  mcp__weather__get_weather: { readOnly: true, live: weather }`,
    );
    const cand = await replay(base, {}, { provider: p, config });
    expect(cand.steps[0]?.replay).toEqual({ tier: "live" });
  });
});

describe("streams", () => {
  it("keeps usage from message_start when message_delta repeats it as null", () => {
    const m = messageFromSse(
      [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "x", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 7 } } })}`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9, input_tokens: null, cache_read_input_tokens: null } })}`,
      ].join("\n\n"),
    );
    expect(m.usage).toMatchObject({ input_tokens: 50, output_tokens: 9, cache_read_input_tokens: 7 });
  });

  it("records a tool call cut off at max_tokens instead of losing the whole reply", () => {
    const m = messageFromSse(
      [
        `data: ${JSON.stringify({ type: "message_start", message: { id: "x", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 1, output_tokens: 1 } } })}`,
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "write", input: {} } })}`,
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"text": "half' } })}`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4 } })}`,
      ].join("\n\n"),
    );
    expect(m.stop_reason).toBe("max_tokens");
    expect(m.content[0]).toMatchObject({ type: "tool_use", input: {}, truncated_input: '{"text": "half' });
  });

  it("the proxy breaks the client's connection when the upstream dies mid-reply", async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const errors: Error[] = [];
    const proxy = await startRecordingProxy(new Recorder({ store: new TraceStore(tmp.dir), source: "proxy" }), {
      upstream: url,
      onError: (e) => errors.push(e),
    });
    try {
      const res = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "x" }] }),
      });
      await expect(res.text()).rejects.toThrow();
      expect(errors.some((e) => e.message.includes("cut off"))).toBe(true);
    } finally {
      await proxy.close();
      upstream.closeAllConnections();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});

describe("replay requests", () => {
  it("merges object settings one level deep", () => {
    expect(
      mergeParams(
        { output_config: { effort: "high", format: "x" }, max_tokens: 5 },
        { output_config: { effort: "low" } },
      ),
    ).toEqual({
      output_config: { effort: "low", format: "x" },
      max_tokens: 5,
    });
  });

  it("warns when a description is set on a server tool", () => {
    const { warnings } = candidateRequest(
      { model: "m", messages: [], tools: [{ type: "web_search_20260209", name: "web_search" }] },
      { toolDescriptions: { web_search: "x" } },
    );
    expect(warnings.join()).toContain("server tool");
  });

  it("a forced tool_choice applies to the first turn only", async () => {
    const base = baseline();
    base.request.tool_choice = { type: "any" };
    const p = new ScriptedProvider([
      { content: [toolUse("get_weather", { city: "Paris" })] },
      { content: [text("Sunny.")] },
    ]);
    const cand = await replay(base, {}, { provider: p });
    expect(p.requests[0]?.tool_choice).toEqual({ type: "any" });
    expect(p.requests[1]?.tool_choice).toEqual({ type: "auto" });
    expect(cand.request.tool_choice).toEqual({ type: "any" });
    expect(cand.replay?.warnings.join()).toContain("first turn only");
  });

  it("turns MCP content into blocks the API accepts", () => {
    expect(
      toResultContent([
        { type: "text", text: "hi", annotations: { audience: ["user"] } },
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
        { type: "resource", resource: { uri: "file:///a.md", text: "body" } },
        { type: "resource_link", uri: "file:///b.md", name: "b" },
      ]),
    ).toEqual([
      { type: "text", text: "hi" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      { type: "text", text: "file:///a.md\nbody" },
      { type: "text", text: "[resource link] file:///b.md" },
    ]);
  });

  it("prices dated model ids but not unknown versions", () => {
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(priceFor("claude-haiku-4-5"));
    expect(priceFor("claude-opus-5-9")).toBeUndefined();
  });

  it("forwards to TRACEWARP_UPSTREAM, then ANTHROPIC_BASE_URL, then the public API", () => {
    expect(defaultUpstream({ TRACEWARP_UPSTREAM: "http://a", ANTHROPIC_BASE_URL: "http://b" })).toBe("http://a");
    expect(defaultUpstream({ ANTHROPIC_BASE_URL: "http://b" })).toBe("http://b");
    expect(defaultUpstream({})).toBe("https://api.anthropic.com");
  });
});

describe("batches and summaries", () => {
  it("leaves error and unreplayable runs out of the cost and time totals", () => {
    const base = baseline();
    const same = diffTraces(base, base);
    const broken = { ...diffTraces(base, base), verdict: "error" as const, costUsd: { baseline: 1, candidate: 0 } };
    const s = summarize([same, broken]);
    expect(s.excluded).toBe(1);
    expect(s.costUsd.baseline).toBeCloseTo(same.costUsd.baseline as number);
  });

  it("keeps going when one replay crashes, and stops when the API refuses the key", async () => {
    const store = new TraceStore(tmp.dir);
    const crashing: Provider = {
      create: () => {
        throw Object.assign(new Error("invalid x-api-key"), { status: 401 });
      },
    };
    const result = await runReplays({
      store,
      baselines: [baseline(), baseline(), baseline()],
      changes: {},
      provider: crashing,
      config: parseConfig(""),
      concurrency: 1,
    });
    expect(result.aborted).toContain("401");
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]?.verdict).toBe("error");
    expect(existsSync(join(result.dir, "summary.json"))).toBe(true);
  });

  it("finds replayed traces by id, and rejects ids that are not safe file names", async () => {
    const store = new TraceStore(tmp.dir);
    const p = new ScriptedProvider([
      { content: [toolUse("get_weather", { city: "Paris" })] },
      { content: [toolUse("get_weather", { city: "Rome" })] },
      { content: [text("Both are sunny.")] },
    ]);
    const result = await runReplays({
      store,
      baselines: [baseline()],
      changes: {},
      provider: p,
      config: parseConfig(""),
    });
    const id = result.candidates[0]?.id as string;
    expect(store.load(id).id).toBe(id);
    expect(store.load(id.slice(0, 10)).id).toBe(id);
    const bad = { ...baseline(), id: "../../etc/x" };
    expect(() => parseTrace(JSON.stringify(bad))).toThrow(TraceFormatError);
  });
});

describe("tracewarp replay exit codes (CLI)", () => {
  it("--fail-on-change exits 1 on a change; unfinished traces are skipped unless asked for", async () => {
    const api = await fakeApi(() => ({ content: [text("No tools needed: it is 30C.")] }));
    try {
      const dir = join(tmp.dir, ".tw");
      const store = new TraceStore(dir);
      store.save(baseline("tw_done"));
      store.save({ ...baseline("tw_unfinished"), status: "incomplete" });
      const env = { ...process.env, TRACEWARP_ANTHROPIC_API_KEY: "test", TRACEWARP_UPSTREAM: api.url };
      const r = await run(process.execPath, [CLI, "--dir", dir, "replay", "--all", "--fail-on-change"], {
        env,
        cwd: tmp.dir,
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("CHANGED");
      expect(r.stdout).toContain("1 runs replayed");
      expect(r.stderr).toContain("skipped 1 traces");
      const plain = await run(process.execPath, [CLI, "--dir", dir, "replay", "--all", "--include-incomplete"], {
        env,
        cwd: tmp.dir,
      });
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain("2 runs replayed");
    } finally {
      await api.close();
    }
  });
});

describe("second review", () => {
  it("a proxy pointed at itself refuses the call instead of looping, and so does a replay sent to it", async () => {
    const store = new TraceStore(tmp.dir);
    const port = await freePort();
    const proxy = await startRecordingProxy(new Recorder({ store, source: "proxy" }), {
      port,
      upstream: `http://127.0.0.1:${port}`,
    });
    try {
      const res = await fetch(`${proxy.url}/v1/messages`, { method: "POST", body: "{}" });
      expect(res.status).toBe(508);
      expect(proxy.calls()).toBe(2);
      const provider = new AnthropicProvider({ apiKey: "k", baseURL: proxy.url, maxRetries: 0 });
      await expect(provider.create({ model: "m", max_tokens: 5, messages: [] })).rejects.toThrow(/TraceWarp itself/);
      expect(store.list()).toHaveLength(0);
    } finally {
      await proxy.close();
    }
  });

  it("close() gives up on a stuck upstream after the grace period", async () => {
    const stuck = createServer(() => undefined);
    await new Promise<void>((r) => stuck.listen(0, "127.0.0.1", () => r()));
    const proxy = await startRecordingProxy(new Recorder({ store: new TraceStore(tmp.dir), source: "proxy" }), {
      upstream: `http://127.0.0.1:${(stuck.address() as AddressInfo).port}`,
    });
    const pending = fetch(`${proxy.url}/v1/messages`, { method: "POST", body: "{}" }).catch(() => "cut");
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await proxy.close(100);
    expect(Date.now() - started).toBeLessThan(2000);
    await pending;
    stuck.closeAllConnections();
    await new Promise<void>((r) => stuck.close(() => r()));
  });

  it("records nothing when the client leaves mid-reply, and stops the upstream call", async () => {
    let upstreamClosed = false;
    const slow = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hi\n\n");
      res.on("close", () => {
        upstreamClosed = true;
      });
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", () => r()));
    const store = new TraceStore(tmp.dir);
    const proxy = await startRecordingProxy(new Recorder({ store, source: "proxy" }), {
      upstream: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`,
    });
    try {
      const ac = new AbortController();
      const res = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "x" }] }),
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      ac.abort();
      for (let i = 0; i < 40 && !upstreamClosed; i++) await new Promise((r) => setTimeout(r, 25));
      expect(upstreamClosed).toBe(true);
      expect(store.list()).toHaveLength(0);
    } finally {
      await proxy.close(100);
      slow.closeAllConnections();
      await new Promise<void>((r) => slow.close(() => r()));
    }
  });

  it("falls back to a fuzzy recorded answer when a live server is down", async () => {
    const base = recordedTrace({
      task: "Weather?",
      turns: [[toolUse("mcp__weather__get_weather", { city: "oslo" })], [text("Done.")]],
      tools: weather,
    });
    const p = new ScriptedProvider([
      { content: [toolUse("mcp__weather__get_weather", { city: "Oslo" })] },
      { content: [text("Oslo is sunny.")] },
    ]);
    const config = parseConfig(
      `servers:\n  weather: { command: ["${process.execPath}", "${join(tmp.dir, "missing.mjs")}"] }\ntools:\n  mcp__weather__get_weather: { readOnly: true, live: weather }`,
    );
    const cand = await replay(base, {}, { provider: p, config });
    expect(cand.steps[0]?.replay).toMatchObject({ tier: "fuzzy", note: expect.stringContaining("live call failed") });
  });

  it("prices Bedrock and Vertex model ids", () => {
    const haiku = priceFor("claude-haiku-4-5");
    expect(priceFor("anthropic.claude-haiku-4-5-20251001-v1:0")).toEqual(haiku);
    expect(priceFor("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toEqual(haiku);
    expect(priceFor("claude-haiku-4-5@20251001")).toEqual(haiku);
  });

  it("redacts MCP connector tokens, and keeps an agent whose tool list grows in one trace", () => {
    const store = new TraceStore(tmp.dir);
    const rec = new Recorder({ store, source: "sdk" });
    const first: Anthropic.MessageParam[] = [{ role: "user", content: "go" }];
    const use = toolUse("load_tools", {});
    const tool = (name: string) => ({ name, input_schema: { type: "object" } });
    rec.record({
      body: {
        model: "m",
        max_tokens: 5,
        tools: [tool("load_tools")],
        mcp_servers: [{ type: "url", url: "https://x", name: "x", authorization_token: "tok-secret" }],
        messages: first,
      },
      response: fakeMessage({ content: [use] }),
      startedAt: 1,
      latencyMs: 1,
    });
    rec.record({
      body: {
        model: "m",
        max_tokens: 5,
        tools: [tool("load_tools"), tool("search")],
        messages: [...first, { role: "assistant", content: [use] }, { role: "user", content: "continue" }],
      },
      response: fakeMessage({ content: [text("done")] }),
      startedAt: 2,
      latencyMs: 1,
    });
    const traces = store.list();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.exchanges).toHaveLength(2);
    expect(JSON.stringify(traces[0])).not.toContain("tok-secret");
    expect(JSON.stringify(traces[0])).toContain("[redacted]");
  });

  it("identifiers are case-sensitive, and the tool_choice reset keeps its other settings", async () => {
    expect(inputSimilarity({ id: "ord_8f2A" }, { id: "ord_8f2a" })).toBe(0);
    const base = baseline();
    base.request.tool_choice = { type: "tool", name: "get_weather", disable_parallel_tool_use: true };
    const p = new ScriptedProvider([
      { content: [toolUse("get_weather", { city: "Paris" })] },
      { content: [text("Sunny.")] },
    ]);
    await replay(base, {}, { provider: p });
    expect(p.requests[1]?.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
