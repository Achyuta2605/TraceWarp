import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import { answerChanged, diffTraces, summarize } from "../src/diff.js";
import { candidateRequest } from "../src/engine.js";
import { canonical, inputSimilarity, jsonChanges, textSimilarity } from "../src/json.js";
import { mcpToolName } from "../src/live.js";
import { costUsd, priceFor } from "../src/pricing.js";
import { fakeMessage } from "../src/provider.js";
import { messageFromSse, StreamError } from "../src/sse.js";
import { parseTrace, TraceFormatError } from "../src/trace.js";
import { recordedTrace, sseFor, text, toolUse } from "./helpers.js";

describe("json helpers", () => {
  it("canonical ignores key order", () => {
    expect(canonical({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } })).toBe(
      canonical({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }),
    );
  });

  it("jsonChanges lists changed, added and removed leaves", () => {
    expect(jsonChanges({ a: 1, b: { c: "x" }, gone: true }, { a: 1, b: { c: "y" }, new: [1] })).toEqual([
      { path: "b.c", before: "x", after: "y" },
      { path: "gone", before: true },
      { path: "new[0]", after: 1 },
    ]);
  });

  it("inputSimilarity scores near-identical inputs high and different ones low", () => {
    expect(inputSimilarity({ path: "src/app.ts" }, { path: "src/app.ts" })).toBe(1);
    expect(inputSimilarity({ path: "src/app.ts" }, { path: "./src/app.ts" })).toBeGreaterThan(0.8);
    expect(inputSimilarity({ city: "Paris" }, { city: "Tokyo" })).toBeLessThan(0.5);
    expect(inputSimilarity({ a: 1, b: 2 }, { a: 1 })).toBe(0.5);
    expect(inputSimilarity({}, {})).toBe(1);
  });

  it("textSimilarity handles short and long text", () => {
    expect(textSimilarity("Hello", "hello ")).toBe(1);
    expect(textSimilarity("", "x")).toBe(0);
    const long = "word ".repeat(200);
    expect(textSimilarity(long, `${long} extra`)).toBeGreaterThan(0.4);
  });
});

describe("pricing", () => {
  it("prices known models, including suffixed ids", () => {
    expect(priceFor("claude-opus-5-5[1m]")?.input).toBe(4);
    expect(priceFor("anthropic.claude-haiku-5-5")?.output).toBe(0.5);
    expect(priceFor("gpt-x")).toBeUndefined();
  });

  it("computes cost from token usage", () => {
    const c = costUsd("claude-sonnet-5-5", {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(c).toBeCloseTo(2 + 1 + 0.1, 6);
    expect(
      costUsd("unknown-model", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toBeNull();
  });
});

describe("SSE", () => {
  it("rebuilds text and tool_use blocks from a stream", () => {
    const m = fakeMessage({ content: [text("Let me check."), toolUse("search", { query: "retry policy", n: 3 })] });
    const rebuilt = messageFromSse(sseFor(m));
    expect(rebuilt.content).toEqual([
      { type: "text", text: "Let me check." },
      expect.objectContaining({ type: "tool_use", name: "search", input: { query: "retry policy", n: 3 } }),
    ]);
    expect(rebuilt.stop_reason).toBe("tool_use");
    expect(rebuilt.usage.output_tokens).toBe(20);
  });

  it("throws on an error event", () => {
    expect(() =>
      messageFromSse('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n'),
    ).toThrow(StreamError);
  });

  it("accumulates thinking and signature deltas", () => {
    const stream = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"usage":{"input_tokens":5,"output_tokens":1}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
    ].join("\n\n");
    const m = messageFromSse(`${stream}\n\n`);
    expect(m.content[0]).toEqual({ type: "thinking", thinking: "hmm", signature: "sig" });
    expect(m.usage).toMatchObject({ input_tokens: 5, output_tokens: 9 });
  });
});

describe("config", () => {
  it("applies defaults", () => {
    const c = parseConfig("");
    expect(c.replay).toEqual({
      fuzzyThreshold: 0.85,
      onMiss: "stop",
      simulate: false,
      simulateModel: "claude-haiku-5-5",
      maxTurns: 50,
    });
  });

  it("refuses live calls for tools not marked read-only, and unknown servers", () => {
    expect(() => parseConfig("tools:\n  write_file: { live: fs }\nservers:\n  fs: { command: [x] }")).toThrow(
      /readOnly/,
    );
    expect(() => parseConfig("tools:\n  read_file: { readOnly: true, live: nope }")).toThrow(/no server named "nope"/);
    expect(() => parseConfig("replay: { onMiss: explode }")).toThrow(ConfigError);
    expect(() => parseConfig("typo: 1")).toThrow(ConfigError);
  });
});

describe("candidateRequest", () => {
  const recorded = {
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    temperature: 0.2,
    thinking: { type: "disabled" },
    tool_choice: { type: "tool", name: "search" },
    system: "old",
    tools: [
      { name: "search", description: "old search" },
      { name: "delete", description: "dangerous" },
    ],
    messages: [{ role: "user" as const, content: "hi" }],
  };

  it("applies model, system, tool and param changes", () => {
    const { body } = candidateRequest(recorded, {
      model: "claude-sonnet-4-6",
      system: "new",
      toolDescriptions: { search: "better search" },
      removeTools: ["delete"],
      params: { max_tokens: 5 },
    });
    expect(body).toMatchObject({
      system: "new",
      max_tokens: 5,
      tools: [{ name: "search", description: "better search" }],
    });
    expect(body.messages).toBeUndefined();
  });

  it("drops settings the new model rejects, and says so", () => {
    const { body, warnings } = candidateRequest(recorded, { model: "claude-opus-5-5" });
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(warnings).toHaveLength(3);
  });

  it("keeps settings the user set explicitly, and warns about unknown tools", () => {
    const { body, warnings } = candidateRequest(recorded, {
      model: "claude-opus-5-5",
      params: { temperature: 1 },
      removeTools: ["nope"],
    });
    expect(body.temperature).toBe(1);
    expect(warnings.some((w) => w.includes('"nope"'))).toBe(true);
  });
});

describe("diff", () => {
  const weather = (_: string, input: Record<string, unknown>) => `sunny in ${input.city}`;
  const base = recordedTrace({
    task: "Weather in Paris and Rome?",
    turns: [
      [toolUse("get_weather", { city: "Paris" })],
      [toolUse("get_weather", { city: "Rome" })],
      [text("Paris and Rome are sunny.")],
    ],
    tools: weather,
  });

  it("reports same for an identical run", () => {
    const d = diffTraces(base, base);
    expect(d.verdict).toBe("same");
    expect(d.firstDivergence).toBeNull();
    expect(d.tools.sameSequence).toBe(true);
  });

  it("finds the first step where arguments changed", () => {
    const cand = recordedTrace({
      task: "Weather in Paris and Rome?",
      turns: [
        [toolUse("get_weather", { city: "Paris" })],
        [toolUse("get_weather", { city: "Milan" })],
        [text("Paris and Rome are sunny.")],
      ],
      tools: weather,
    });
    const d = diffTraces(base, cand);
    expect(d.verdict).toBe("changed");
    expect(d.firstDivergence).toMatchObject({ step: 1, kind: "arguments" });
    expect(d.tools.argChanges[0]?.changes).toEqual([{ path: "city", before: "Rome", after: "Milan" }]);
  });

  it("finds extra, missing and different tools", () => {
    const extra = recordedTrace({
      task: "t",
      turns: [
        [toolUse("get_weather", { city: "Paris" })],
        [toolUse("get_weather", { city: "Rome" })],
        [toolUse("search", { query: "x" })],
        [text("Paris and Rome are sunny.")],
      ],
      tools: weather,
    });
    expect(diffTraces(base, extra).firstDivergence).toMatchObject({ step: 2, kind: "extra_call", candidate: "search" });
    expect(diffTraces(base, extra).tools.added).toEqual(["search"]);
    expect(diffTraces(extra, base).firstDivergence).toMatchObject({ kind: "missing_call" });
    const other = recordedTrace({
      task: "t",
      turns: [[toolUse("search", { query: "weather" })], [text("No idea.")]],
      tools: weather,
    });
    expect(diffTraces(base, other).firstDivergence).toMatchObject({
      step: 0,
      kind: "tool",
      baseline: "get_weather",
      candidate: "search",
    });
  });

  it("flags a changed final answer when the tool path is identical", () => {
    const cand = recordedTrace({
      task: "t",
      turns: [
        [toolUse("get_weather", { city: "Paris" })],
        [toolUse("get_weather", { city: "Rome" })],
        [text("I could not find anything useful.")],
      ],
      tools: weather,
    });
    expect(diffTraces(base, cand).firstDivergence?.kind).toBe("final_answer");
  });

  it("treats reworded answers with the same facts as the same answer", () => {
    const a = "Retry at most 3 times: 200 ms, 400 ms, 800 ms. Never retry HTTP 409 (policies/retry-policy.md).";
    const b =
      "Per policies/retry-policy.md we retry 3 times with backoff of 200 ms, 400 ms and 800 ms, and never on a 409.";
    expect(answerChanged(a, b)).toMatchObject({ changed: false, factOverlap: 1 });
    const c = "Retry 5 times with 1 s backoff.";
    expect(answerChanged(a, c)).toMatchObject({ changed: true });
    expect(answerChanged(a, c).missingFacts).toContain("409");
  });

  it("summarizes a batch", () => {
    const cand = recordedTrace({
      task: "t",
      turns: [[toolUse("search", { query: "weather" })], [text("No idea.")]],
      tools: weather,
    });
    const s = summarize([diffTraces(base, base), diffTraces(base, cand)]);
    expect(s.verdicts).toMatchObject({ same: 1, changed: 1 });
    expect(s.toolPathChanged).toBe(0.5);
    expect(s.answerChanged).toBe(0.5);
  });
});

describe("trace files", () => {
  it("rejects files that are not traces", () => {
    expect(() => parseTrace("not json")).toThrow(TraceFormatError);
    expect(() => parseTrace('{"version": 1}')).toThrow(/not a TraceWarp trace/);
  });

  it("mcpToolName strips Claude Code's mcp__server__ prefix", () => {
    expect(mcpToolName("mcp__fs__read_text_file")).toBe("read_text_file");
    expect(mcpToolName("mcp__my_server__get")).toBe("get");
    expect(mcpToolName("read_file")).toBe("read_file");
  });
});
