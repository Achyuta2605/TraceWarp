import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { diffTraces, type RunSummary, summarize, type TraceDiff } from "./diff.js";
import { type Changes, replay } from "./engine.js";
import { LiveTools } from "./live.js";
import type { Provider } from "./provider.js";
import { newTraceId, type Trace, type TraceStore } from "./trace.js";

/** A batch replay: every chosen trace replayed once with the same changes, saved under <dir>/runs/<id>/. */

export interface RunResult {
  id: string;
  dir: string;
  diffs: TraceDiff[];
  summary: RunSummary;
  candidates: Trace[];
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
  const worker = async () => {
    while (next < opts.baselines.length) {
      const i = next++;
      const baseline = opts.baselines[i] as Trace;
      const candidate = await replay(baseline, opts.changes, {
        provider: opts.provider,
        config: opts.config,
        ...(live ? { live } : {}),
      });
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
    await live?.close();
  }
  const done = results.filter((r): r is { diff: TraceDiff; candidate: Trace } => r !== undefined);
  const diffs = done.map((r) => r.diff);
  const summary = summarize(diffs);
  writeFileSync(join(dir, "diffs.json"), `${JSON.stringify(diffs, null, 2)}\n`);
  writeFileSync(
    join(dir, "summary.json"),
    `${JSON.stringify({ id, createdAt: Date.now(), changes: opts.changes, baselines: opts.baselines.map((b) => b.id), summary }, null, 2)}\n`,
  );
  return { id, dir, diffs, summary, candidates: done.map((r) => r.candidate) };
}
