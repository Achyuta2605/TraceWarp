import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { diffTraces, type RunSummary, summarize, type TraceDiff } from "./diff.js";
import { type Changes, replay } from "./engine.js";
import { LiveTools } from "./live.js";
import type { Provider } from "./provider.js";
import { buildTrace, newTraceId, type Trace, type TraceStore } from "./trace.js";

/** A batch replay: every chosen trace replayed once with the same changes, saved under <dir>/runs/<id>/. */

export interface RunResult {
  id: string;
  dir: string;
  diffs: TraceDiff[];
  summary: RunSummary;
  candidates: Trace[];
  /** Set when the run stopped early because the API refused the key: no point replaying the rest. */
  aborted?: string;
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
  onDone?: (diff: TraceDiff, candidate: Trace, baseline: Trace) => void;
}): Promise<RunResult> {
  const id = newTraceId("run");
  const dir = join(opts.store.runsDir, id);
  const candidatesDir = join(dir, "candidates");
  mkdirSync(candidatesDir, { recursive: true });
  const live = Object.keys(opts.config.servers).length ? new LiveTools(opts.config.servers) : undefined;
  const results: Array<{ diff: TraceDiff; candidate: Trace } | undefined> = new Array(opts.baselines.length);
  let next = 0;
  let aborted: string | undefined;
  const worker = async () => {
    while (next < opts.baselines.length && !aborted) {
      const i = next++;
      const baseline = opts.baselines[i] as Trace;
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
      const diff = diffTraces(baseline, candidate);
      results[i] = { diff, candidate };
      opts.onDone?.(diff, candidate, baseline);
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, opts.baselines.length)) }, worker),
    );
  } finally {
    await live?.close().catch(() => undefined);
  }
  const done = results.filter((r): r is { diff: TraceDiff; candidate: Trace } => r !== undefined);
  const diffs = done.map((r) => r.diff);
  const summary = summarize(diffs);
  writeFileSync(join(dir, "diffs.json"), `${JSON.stringify(diffs, null, 2)}\n`);
  writeFileSync(
    join(dir, "summary.json"),
    `${JSON.stringify({ id, createdAt: Date.now(), changes: opts.changes, baselines: opts.baselines.map((b) => b.id), summary, ...(aborted ? { aborted } : {}) }, null, 2)}\n`,
  );
  return { id, dir, diffs, summary, candidates: done.map((r) => r.candidate), ...(aborted ? { aborted } : {}) };
}
