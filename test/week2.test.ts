import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { diffTraces, summarize } from "../src/diff.js";
import { applyJudgement, ClaudeJudge, JudgeError, parseJudgement } from "../src/judge.js";
import { ScriptedProvider } from "../src/provider.js";
import { renderMarkdown, renderReport } from "../src/report.js";
import { runReplays } from "../src/run.js";
import { TraceStore } from "../src/trace.js";
import { CLI, fakeApi, recordedTrace, run, tempDir, text, toolUse } from "./helpers.js";

const weather = (_: string, input: Record<string, unknown>) => `recorded: sunny in ${input.city}`;

function baseline(answer = "Paris is sunny, 22C.", id?: string) {
  return recordedTrace({
    task: "Weather in Paris?",
    turns: [[toolUse("get_weather", { city: "Paris" })], [text(answer)]],
    tools: weather,
    ...(id ? { id } : {}),
  });
}

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

describe("Claude judge", () => {
  it("reads a verdict from a reply, with or without a code fence, and rejects anything else", () => {
    expect(parseJudgement('```json\n{"verdict":"changed","reason":"22C became 30C","lost":["22C"]}\n```')).toEqual({
      verdict: "changed",
      reason: "22C became 30C",
      lost: ["22C"],
    });
    expect(parseJudgement('Here: {"verdict":"same","reason":"reworded"}')).toMatchObject({ verdict: "same", lost: [] });
    expect(() => parseJudgement('{"verdict":"maybe"}')).toThrow(JudgeError);
    expect(() => parseJudgement("no idea")).toThrow(JudgeError);
  });

  it("asks once per pair and answers repeats from its cache", async () => {
    const p = new ScriptedProvider([
      { content: [text('{"verdict":"same","reason":"Only wording differs.","lost":[]}')] },
    ]);
    const cachePath = join(tmp.dir, "judge-cache.json");
    const j = new ClaudeJudge(p, { model: "claude-haiku-5-5", cachePath });
    const input = { task: "t", baseline: "It is 22C.", candidate: "22C, sunny." };
    expect(await j.judge(input)).toMatchObject({ verdict: "same", model: "claude-haiku-5-5" });
    expect(await new ClaudeJudge(p, { model: "claude-haiku-5-5", cachePath }).judge(input)).toMatchObject({
      verdict: "same",
    });
    expect(p.requests).toHaveLength(1);
    expect(String(((p.requests[0]?.messages ?? []) as Anthropic.MessageParam[])[0]?.content)).toContain(
      '"recorded_answer": "It is 22C."',
    );
    expect(await j.judge({ task: "t", baseline: "same", candidate: " same " })).toMatchObject({ model: "exact" });
    expect(p.requests).toHaveLength(1);
  });

  it("overrides the key-facts result on the answer but keeps tool-path changes", () => {
    const base = baseline("Paris is sunny, 22C. See weather.md");
    const reworded = baseline("Sunny in Paris (22C), per weather.md.");
    const d = diffTraces(base, reworded);
    const same = applyJudgement(d, { verdict: "same", reason: "reworded", lost: [], model: "m" });
    expect(same.verdict).toBe("same");
    expect(same.final.judge?.reason).toBe("reworded");
    const changed = applyJudgement(d, { verdict: "changed", reason: "x", lost: ["22C"], model: "m" });
    expect(changed.verdict).toBe("changed");
    expect(changed.firstDivergence?.kind).toBe("final_answer");

    const otherPath = recordedTrace({
      task: "Weather in Paris?",
      turns: [[toolUse("search", { q: "Paris" })], [text("Paris is sunny, 22C. See weather.md")]],
      tools: weather,
    });
    const pathChanged = applyJudgement(diffTraces(base, otherPath), {
      verdict: "same",
      reason: "",
      lost: [],
      model: "m",
    });
    expect(pathChanged.verdict).toBe("changed");
    expect(pathChanged.firstDivergence?.kind).toBe("tool");
  });

  it("a batch with a judge records its ruling, and a failing judge falls back to key facts", async () => {
    const store = new TraceStore(tmp.dir);
    const p = new ScriptedProvider([
      { content: [toolUse("get_weather", { city: "Paris" })] },
      { content: [text("It's 22C and sunny in Paris.")] },
    ]);
    const result = await runReplays({
      store,
      baselines: [baseline()],
      changes: {},
      provider: p,
      config: parseConfig(""),
      judge: { judge: async () => ({ verdict: "same", reason: "Same temperature.", lost: [], model: "judge-x" }) },
    });
    expect(result.diffs[0]?.final.judge?.model).toBe("judge-x");

    const p2 = new ScriptedProvider([
      { content: [toolUse("get_weather", { city: "Paris" })] },
      { content: [text("It's 22C and sunny in Paris.")] },
    ]);
    const failed = await runReplays({
      store,
      baselines: [baseline()],
      changes: {},
      provider: p2,
      config: parseConfig(""),
      judge: {
        judge: async () => {
          throw new Error("overloaded");
        },
      },
    });
    expect(failed.diffs[0]?.final.judgeError).toBe("overloaded");
    expect(failed.diffs[0]?.verdict).toBe("same");
  });
});

describe("repeats and flaky traces", () => {
  it("replays each trace n times and flags traces whose replays disagree", async () => {
    const store = new TraceStore(tmp.dir);
    const answers = ["Paris is sunny, 22C.", "Paris: 30C and rain.", "Paris is sunny, 22C."];
    let k = 0;
    const p = new ScriptedProvider(
      Array.from({ length: 6 }, (_, i) =>
        i % 2 === 0
          ? { content: [toolUse("get_weather", { city: "Paris" })] }
          : { content: [text(answers[k++] ?? "")] },
      ),
    );
    const result = await runReplays({
      store,
      baselines: [baseline()],
      changes: {},
      provider: p,
      config: parseConfig(""),
      repeat: 3,
      concurrency: 1,
    });
    expect(result.summary.runs).toBe(3);
    expect(result.summary.traces).toBe(1);
    expect(result.summary.verdicts).toMatchObject({ same: 2, changed: 1 });
    expect(result.summary.changedTraces).toBe(0);
    expect(result.summary.flaky).toEqual([
      expect.objectContaining({ baselineId: result.diffs[0]?.baselineId, same: 2, changed: 1 }),
    ]);
  });
});

describe("reports", () => {
  it("writes a self-contained HTML report and a Markdown summary, escaping recorded text", () => {
    const base = baseline("<script>alert(1)</script> 22C");
    const cand = baseline("30C | rain");
    const diffs = [diffTraces(base, cand), diffTraces(base, base)];
    const input = {
      runId: "run_x",
      createdAt: 0,
      changes: { model: "claude-haiku-5-5" },
      summary: summarize(diffs),
      diffs,
    };
    const html = renderReport(input);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<link|src="http/);
    expect(html).toContain("prefers-color-scheme:dark");
    const md = renderMarkdown(input);
    expect(md).toContain("**1 same · 1 changed");
    expect(md).toContain("| changed | Weather in Paris? |");
    expect(md).not.toContain("30C | rain");
  });
});

describe("tracewarp replay --judge and report (CLI)", () => {
  it("judges answers through the API, saves a report, and rebuilds it on request", async () => {
    const api = await fakeApi((body) => {
      if (String(body.system ?? "").includes("RECORDED answer")) {
        return { content: [text('{"verdict":"same","reason":"Same forecast, new words.","lost":[]}')] };
      }
      const n = (body.messages as unknown[]).length;
      return n === 1
        ? { content: [toolUse("get_weather", { city: "Paris" })] }
        : { content: [text("Sunny in Paris today at 22 degrees.")] };
    });
    try {
      const dir = join(tmp.dir, ".tw");
      new TraceStore(dir).save(baseline());
      const env = { ...process.env, TRACEWARP_ANTHROPIC_API_KEY: "test", TRACEWARP_UPSTREAM: api.url };
      const r = await run(
        process.execPath,
        [CLI, "--dir", dir, "replay", "--all", "--judge", "--judge-model", "claude-haiku-5-5", "--fail-on-change"],
        { env, cwd: tmp.dir },
      );
      expect(r.stderr).not.toContain("Error");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("judge   same (claude-haiku-5-5): Same forecast, new words.");
      const judgeCall = api.bodies.find((b) => String(b.system ?? "").includes("RECORDED answer"));
      expect(judgeCall?.model).toBe("claude-haiku-5-5");
      const reportLine = r.stdout.split("\n").find((l) => l.includes("report.html")) ?? "";
      const reportPath = reportLine.replace(/^\s*report\s+/, "").trim();
      expect(existsSync(reportPath)).toBe(true);
      expect(readFileSync(reportPath, "utf8")).toContain("Same forecast, new words.");
      expect(existsSync(join(reportPath, "..", "judge-cache.json"))).toBe(false);
      expect(existsSync(join(dir, "judge-cache.json"))).toBe(true);

      const md = await run(process.execPath, [CLI, "--dir", dir, "report", "--md"], { env, cwd: tmp.dir });
      expect(md.status).toBe(0);
      expect(md.stdout).toContain("### TraceWarp replay run_");
      expect(md.stdout).toContain("Every run behaved the same as its recording.");
    } finally {
      await api.close();
    }
  });
});

describe("example live tools", () => {
  it("answers a call the recording never saw from the read-only docs MCP server", async () => {
    const { replay } = await import("../src/engine.js");
    const { loadConfig } = await import("../src/config.js");
    const base = recordedTrace({
      task: "What is R-500?",
      turns: [[toolUse("search", { query: "R-500" })], [text("Ledger write failed.")]],
      tools: () => "runbooks/refund-failures.md:5: R-500 ledger",
    });
    const p = new ScriptedProvider([
      { content: [toolUse("read_file", { path: "runbooks/refund-failures.md" })] },
      { content: [text("R-500 means the ledger write failed.")] },
    ]);
    const cand = await replay(base, {}, { provider: p, config: loadConfig("examples/tracewarp.yaml") });
    expect(cand.steps[0]?.replay).toEqual({ tier: "live" });
    expect(JSON.stringify(cand.steps[0]?.result)).toContain("Do NOT retry; page the ledger team");
  });
});
