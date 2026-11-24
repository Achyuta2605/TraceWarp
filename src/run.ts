import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { diffTraces, type RunSummary, summarize, type TraceDiff } from "./diff.js";
import { type Changes, replay } from "./engine.js";
import { applyJudgement, type JudgeInput, type Judgement } from "./judge.js";
import { LiveTools } from "./live.js";
import type { Provider } from "./provider.js";
import { renderMarkdown, renderReport } from "./report.js";
import { buildTrace, newTraceId, type Trace, type TraceStore } from "./trace.js";

/**
 * A batch replay: every chosen trace replayed `repeat` times with the same changes, saved under <dir>/runs/<id>/.
 * Repeats measure noise: a real model does not answer the same way twice, so one changed run proves little.
 */

export interface RunResult {
  id: string;
  dir: string;
  diffs: TraceDiff[];
  summary: RunSummary;
  candidates: Trace[];
  /** Set when the run stopped early because the API refused the key: no point replaying the rest. */
  aborted?: string;
}

/** The changes in a form the report can show (long texts cut). */
function describeRunChanges(c: Changes): Record<string, unknown> {
  const out: Record<string, unknown> = { ...c };
  if (typeof c.system === "string") out.system = c.system.length > 120 ? `${c.system.slice(0, 120)}…` : c.system;
  if (c.toolDescriptions) out.toolDescriptions = Object.keys(c.toolDescriptions);
  return out;
}

/** Statuses that will fail every remaining replay the same way. */
const FATAL_STATUS = new Set([401, 403]);

/** A replay that crashed (a bug or an unexpected tool error) still gets a trace, so the batch carries on. */
function crashed(baseline: Trace, e: unknown): Trace {
  return buildTrace({
    id: newTraceId("rp"),
    createdAt: Date.now(),
    source: "replay",
    ...(baseline.label ? { label: baseline.label } : {}),
    status: "error",
    request: baseline.request,
    exchanges: [],
    replay: { baselineId: baseline.id, changes: {}, warnings: [], error: `replay crashed: ${(e as Error).message}` },
  });
}

export async function runReplays(opts: {
  store: TraceStore;
  baselines: Trace[];
  changes: Changes;
  provider: Provider;
  config: Config;
  concurrency?: number;
  /** Replays per trace (default 1). */
  repeat?: number;
  /** Rules on final answers instead of the key-facts check (see judge.ts). */
  judge?: { judge(input: JudgeInput): Promise<Judgement> };
  onDone?: (diff: TraceDiff, candidate: Trace, baseline: Trace) => void;
}): Promise<RunResult> {
  const id = newTraceId("run");
  const dir = join(opts.store.runsDir, id);
  const candidatesDir = join(dir, "candidates");
  mkdirSync(candidatesDir, { recursive: true });
  const live = Object.keys(opts.config.servers).length ? new LiveTools(opts.config.servers) : undefined;
  const repeat = Math.max(1, opts.repeat ?? 1);
  const jobs = opts.baselines.flatMap((b) => Array.from({ length: repeat }, () => b));
  const results: Array<{ diff: TraceDiff; candidate: Trace } | undefined> = new Array(jobs.length);
  let next = 0;
  let aborted: string | undefined;
  const worker = async () => {
    while (next < jobs.length && !aborted) {
      const i = next++;
      const baseline = jobs[i] as Trace;
      let candidate: Trace;
      try {
        candidate = await replay(baseline, opts.changes, {
          provider: opts.provider,
          config: opts.config,
          ...(live ? { live } : {}),
        });
      } catch (e) {
        candidate = crashed(baseline, e);
      }
      const status = candidate.replay?.errorStatus;
      if (status !== undefined && FATAL_STATUS.has(status)) {
        aborted = `the API refused the request (${status}): ${candidate.replay?.error ?? ""}`.trim();
      }
      opts.store.save(candidate, candidatesDir);
      let diff = diffTraces(baseline, candidate);
      if (opts.judge && (diff.verdict === "same" || diff.verdict === "changed")) {
        try {
          diff = applyJudgement(
            diff,
            await opts.judge.judge({
              task: diff.task,
              baseline: diff.final.baselineText,
              candidate: diff.final.candidateText,
            }),
          );
        } catch (e) {
          diff = { ...diff, final: { ...diff.final, judgeError: (e as Error).message } };
        }
      }
      results[i] = { diff, candidate };
      opts.onDone?.(diff, candidate, baseline);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, jobs.length)) }, worker));
  } finally {
    await live?.close().catch(() => undefined);
  }
  const done = results.filter((r): r is { diff: TraceDiff; candidate: Trace } => r !== undefined);
  const diffs = done.map((r) => r.diff);
  const summary = summarize(diffs);
  const createdAt = Date.now();
  const report = { runId: id, createdAt, changes: describeRunChanges(opts.changes), summary, diffs };
  writeFileSync(join(dir, "report.html"), renderReport(report));
  writeFileSync(join(dir, "summary.md"), renderMarkdown(report));
  writeFileSync(join(dir, "diffs.json"), `${JSON.stringify(diffs, null, 2)}\n`);
  writeFileSync(
    join(dir, "summary.json"),
    `${JSON.stringify({ id, createdAt, changes: describeRunChanges(opts.changes), repeat, baselines: opts.baselines.map((b) => b.id), summary, ...(aborted ? { aborted } : {}) }, null, 2)}\n`,
  );
  return { id, dir, diffs, summary, candidates: done.map((r) => r.candidate), ...(aborted ? { aborted } : {}) };
}
