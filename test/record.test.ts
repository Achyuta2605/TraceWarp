import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordingFetch, startRecordingProxy } from "../src/capture.js";
import { fakeMessage } from "../src/provider.js";
import { Recorder } from "../src/recorder.js";
import { TraceStore } from "../src/trace.js";
import { CLI, type FakeApi, fakeApi, ROOT, run, tempDir, text, toolUse } from "./helpers.js";

/** A two-step weather agent: asks for the weather, then answers. */
function weatherApi(): Promise<FakeApi> {
  return fakeApi((body) => {
    const messages = body.messages as Anthropic.MessageParam[];
    const last = messages.at(-1);
    const answered = Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");
    return answered
      ? { content: [text("It is sunny in Paris.")] }
      : { content: [text("Checking."), toolUse("get_weather", { city: "Paris" })] };
  });
}

async function runAgent(client: Anthropic, stream: boolean, task = "Weather in Paris?") {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  for (let i = 0; i < 5; i++) {
    const params = {
      model: "claude-sonnet-5-5",
      max_tokens: 500,
      system: "weather bot",
      tools: [{ name: "get_weather", description: "weather", input_schema: { type: "object" as const } }],
      messages,
    };
    const r = stream ? await client.messages.stream(params).finalMessage() : await client.messages.create(params);
    messages.push({ role: "assistant", content: r.content });
    if (r.stop_reason !== "tool_use") return r;
    const use = r.content.find((b) => b.type === "tool_use") as Anthropic.ToolUseBlock;
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "22C sunny" }] });
  }
  throw new Error("agent did not finish");
}

describe("Recorder", () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => tmp.cleanup());

  it("groups an agent loop into one trace and ends it on end_turn", () => {
    const store = new TraceStore(tmp.dir);
    const rec = new Recorder({ store, source: "sdk", label: "unit" });
    const use = toolUse("get_weather", { city: "Paris" });
    const first: Anthropic.MessageParam[] = [{ role: "user", content: "Weather?" }];
    rec.record({
      body: { model: "m", max_tokens: 10, stream: true, messages: first },
      response: fakeMessage({ content: [use] }),
      startedAt: 1,
      latencyMs: 5,
    });
    expect(rec.openTraces).toBe(1);
    rec.record({
      body: {
        model: "m",
        messages: [
          ...first,
          { role: "assistant", content: [{ type: "tool_use", id: use.id, name: use.name, input: use.input }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "sunny" }] },
        ],
      },
      response: fakeMessage({ content: [text("Sunny.")] }),
      startedAt: 10,
      latencyMs: 7,
    });
    expect(rec.openTraces).toBe(0);
    const [t] = store.list();
    expect(t?.status).toBe("complete");
    expect(t?.label).toBe("unit");
    expect(t?.request).not.toHaveProperty("stream");
    expect(t?.steps).toEqual([
      expect.objectContaining({ name: "get_weather", input: { city: "Paris" }, result: "sunny", turn: 0 }),
    ]);
    expect(t?.final).toEqual({ text: "Sunny.", stopReason: "end_turn", turns: 2 });
    expect(t?.usage.latencyMs).toBe(12);
  });

  it("keeps interleaved tasks apart and flushes unfinished ones as incomplete", () => {
    const store = new TraceStore(tmp.dir);
    const rec = new Recorder({ store, source: "sdk" });
    const a = toolUse("search", { query: "a" });
    const b = toolUse("search", { query: "b" });
    rec.record({
      body: { model: "m", messages: [{ role: "user", content: "A" }] },
      response: fakeMessage({ content: [a] }),
      startedAt: 1,
      latencyMs: 1,
    });
    rec.record({
      body: { model: "m", messages: [{ role: "user", content: "B" }] },
      response: fakeMessage({ content: [b] }),
      startedAt: 2,
      latencyMs: 1,
    });
    rec.record({
      body: {
        model: "m",
        messages: [
          { role: "user", content: "A" },
          { role: "assistant", content: [a] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: a.id, content: "found a" }] },
        ],
      },
      response: fakeMessage({ content: [text("done A")] }),
      startedAt: 3,
      latencyMs: 1,
    });
    expect(store.list()).toHaveLength(1);
    rec.flush();
    const traces = store.list();
    expect(traces.map((t) => [t.final.text, t.status])).toEqual([
      ["done A", "complete"],
      ["", "incomplete"],
    ]);
    expect(traces[0]?.steps[0]?.result).toBe("found a");
  });

  it("starts a new trace when a finished conversation gets a new user message", () => {
    const store = new TraceStore(tmp.dir);
    const rec = new Recorder({ store, source: "sdk" });
    rec.record({
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
      response: fakeMessage({ content: [text("hello")] }),
      startedAt: 1,
      latencyMs: 1,
    });
    rec.record({
      body: {
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "and now?" },
        ],
      },
      response: fakeMessage({ content: [text("now this")] }),
      startedAt: 2,
      latencyMs: 1,
    });
    const traces = store.list();
    expect(traces).toHaveLength(2);
    expect(traces[1]?.request.messages).toHaveLength(3);
  });
});

describe("capture", () => {
  let tmp: ReturnType<typeof tempDir>;
  let api: FakeApi;
  beforeEach(async () => {
    tmp = tempDir();
    api = await weatherApi();
  });
  afterEach(async () => {
    await api.close();
    tmp.cleanup();
  });

  for (const stream of [false, true]) {
    it(`recordingFetch records an SDK agent (${stream ? "streaming" : "plain JSON"}) without changing its replies`, async () => {
      const store = new TraceStore(tmp.dir);
      const rec = new Recorder({ store, source: "sdk" });
      const client = new Anthropic({ apiKey: "test", baseURL: api.url, fetch: recordingFetch(rec), maxRetries: 0 });
      const final = await runAgent(client, stream);
      expect(final.content).toEqual([expect.objectContaining({ type: "text", text: "It is sunny in Paris." })]);
      await new Promise((r) => setTimeout(r, 50));
      const [t] = store.list();
      expect(t?.status).toBe("complete");
      expect(t?.steps).toEqual([
        expect.objectContaining({ name: "get_weather", input: { city: "Paris" }, result: "22C sunny" }),
      ]);
      expect(t?.final.text).toBe("It is sunny in Paris.");
    });

    it(`the recording proxy records an agent that only knows ANTHROPIC_BASE_URL (${stream ? "streaming" : "JSON"})`, async () => {
      const store = new TraceStore(tmp.dir);
      const rec = new Recorder({ store, source: "proxy" });
      const proxy = await startRecordingProxy(rec, { upstream: api.url });
      try {
        const client = new Anthropic({ apiKey: "test", baseURL: proxy.url, maxRetries: 0 });
        const final = await runAgent(client, stream);
        expect(final.content[0]).toMatchObject({ text: "It is sunny in Paris." });
        expect(api.bodies).toHaveLength(2);
        const [t] = store.list();
        expect(t?.source).toBe("proxy");
        expect(t?.steps[0]).toMatchObject({ name: "get_weather", result: "22C sunny" });
        expect(t?.exchanges).toHaveLength(2);
      } finally {
        await proxy.close();
      }
    });
  }

  it("the proxy passes errors and other endpoints through without recording them", async () => {
    const store = new TraceStore(tmp.dir);
    const rec = new Recorder({ store, source: "proxy" });
    const proxy = await startRecordingProxy(rec, { upstream: api.url });
    try {
      const res = await fetch(`${proxy.url}/v1/models`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ type: "error" });
      expect(store.list()).toHaveLength(0);
    } finally {
      await proxy.close();
    }
  });

  it("the proxy answers 502 when the upstream is down", async () => {
    const rec = new Recorder({ store: new TraceStore(tmp.dir), source: "proxy" });
    const proxy = await startRecordingProxy(rec, { upstream: "http://127.0.0.1:9" });
    try {
      const res = await fetch(`${proxy.url}/v1/messages`, { method: "POST", body: "{}" });
      expect(res.status).toBe(502);
    } finally {
      await proxy.close();
    }
  });
});

describe("tracewarp record (CLI)", () => {
  it("runs the example agent through the proxy and saves its trace", async () => {
    const tmp = tempDir();
    const api = await fakeApi((body) => {
      const messages = body.messages as Anthropic.MessageParam[];
      const results = messages.flatMap((m) =>
        Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
      );
      if (results.length === 0) return { content: [toolUse("search", { query: "retry" })] };
      if (results.length === 1) return { content: [toolUse("read_file", { path: "policy.md" })] };
      return { content: [text("policy.md says: retry 3 times.")] };
    });
    try {
      const docs = join(tmp.dir, "docs");
      mkdirSync(docs);
      writeFileSync(join(docs, "policy.md"), "# Policy\nWe retry 3 times.\n");
      const r = await run(
        process.execPath,
        [
          CLI,
          "--dir",
          join(tmp.dir, ".tw"),
          "record",
          "--label",
          "demo",
          "--upstream",
          api.url,
          "--",
          process.execPath,
          "--import",
          "tsx",
          join(ROOT, "examples", "file-agent.ts"),
          docs,
          "What",
          "is",
          "the",
          "retry",
          "policy?",
        ],
        { cwd: ROOT, env: { ...process.env, ANTHROPIC_API_KEY: "test" } },
      );
      expect(r.stderr).toContain("1 traces recorded from 3 API calls");
      expect(r.stdout).toContain("retry 3 times");
      expect(r.status).toBe(0);
      const [t] = new TraceStore(join(tmp.dir, ".tw")).list();
      expect(t?.label).toBe("demo");
      expect(t?.steps.map((s) => s.name)).toEqual(["search", "read_file"]);
      expect(t?.steps[0]?.result).toContain("policy.md:2: We retry 3 times.");
      expect(t?.steps[1]?.result).toContain("# Policy");
      const list = await run(process.execPath, [CLI, "--dir", join(tmp.dir, ".tw"), "list"]);
      expect(list.stdout).toContain(t?.id);
      const show = await run(
        process.execPath,
        [CLI, "--dir", join(tmp.dir, ".tw"), "show", t?.id.slice(0, 10) ?? ""],
        {},
      );
      expect(show.stdout).toContain("read_file");
      expect(show.stdout).toContain("retry 3 times");
    } finally {
      await api.close();
      tmp.cleanup();
    }
  });
});
