import type { RunSummary, TraceDiff } from "./diff.js";
import { type Trace, taskText } from "./trace.js";

/** Plain-text output for the CLI. */

/** Shown when prompt caching made the bill differ from the cache-neutral cost that is compared. */
export function billedNote(d: Pick<TraceDiff, "costUsd" | "billedCostUsd">): string {
  const b = d.billedCostUsd;
  if (!b) return "";
  const same = (x: number | null, y: number | null) => x === y || (x !== null && y !== null && Math.abs(x - y) < 1e-6);
  if (same(b.baseline, d.costUsd.baseline) && same(b.candidate, d.costUsd.candidate)) return "";
  return `   (billed ${money(b.baseline)} → ${money(b.candidate)} with prompt cache; cost above is without it)`;
}

export function money(n: number | null): string {
  if (n === null) return "n/a";
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function change(before: number | null, after: number | null): string {
  if (before === null || after === null || before === 0) return "";
  const d = (after - before) / before;
  return ` (${d >= 0 ? "+" : ""}${Math.round(d * 100)}%)`;
}

function cut(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

const firstUserText = taskText;

export function formatTraceList(traces: Trace[]): string {
  if (!traces.length) return "No traces yet. Record some with: tracewarp record -- <your agent command>";
  const rows = traces.map((t) => {
    const when = new Date(t.createdAt).toISOString().replace("T", " ").slice(0, 16);
    return `${t.id.padEnd(22)} ${when}  ${t.request.model.padEnd(18)} ${String(t.steps.length).padStart(3)} calls  ${t.status.padEnd(10)} ${cut(firstUserText(t), 50)}`;
  });
  return [
    `${"ID".padEnd(22)} ${"RECORDED (UTC)".padEnd(17)} ${"MODEL".padEnd(18)} TOOLS      STATUS     TASK`,
    ...rows,
  ].join("\n");
}

export function formatTrace(t: Trace): string {
  const lines = [
    `${t.id}  ${t.status}  ${t.request.model}  ${t.final.turns} turns, ${t.steps.length} tool calls, ${money(t.usage.costUsd)}, ${(t.usage.latencyMs / 1000).toFixed(1)}s`,
    `Task: ${cut(firstUserText(t), 200)}`,
  ];
  if (t.replay) lines.push(`Replay of ${t.replay.baselineId} with ${JSON.stringify(t.replay.changes)}`);
  t.steps.forEach((s, i) => {
    const where = s.server ? ` [${s.server}]` : "";
    const tier = s.replay
      ? ` (${s.replay.tier}${s.replay.similarity !== undefined ? ` ${s.replay.similarity}` : ""})`
      : "";
    lines.push(
      `  ${String(i + 1).padStart(2)}. ${s.name}${where}${tier} ${cut(JSON.stringify(s.input), 90)}${s.isError ? "  ERROR" : ""}`,
    );
  });
  lines.push(`Final (${t.final.stopReason}): ${cut(t.final.text, 300)}`);
  return lines.join("\n");
}

export function describeDivergence(d: TraceDiff): string {
  const f = d.firstDivergence;
  if (!f) return "no divergence";
  const at = `step ${f.step + 1}`;
  switch (f.kind) {
    case "tool":
      return `${at}: called ${f.candidate} instead of ${f.baseline}`;
    case "arguments":
      return `${at}: same tool, different arguments`;
    case "extra_call":
      return `${at}: made an extra call to ${f.candidate}`;
    case "missing_call":
      return `${at}: stopped before calling ${f.baseline}`;
    case "stop_reason":
      return `ended differently (${f.baseline} → ${f.candidate})`;
    case "final_answer":
      return "same tool path, different final answer";
  }
}

export function formatDiff(d: TraceDiff): string {
  const lines = [
    `${d.baselineId} → ${d.candidateId}: ${d.verdict.toUpperCase()}  (${describeDivergence(d)})`,
    `  tools   ${d.tools.baseline.join(" → ") || "(none)"}`,
    `  replay  ${d.tools.candidate.join(" → ") || "(none)"}`,
  ];
  if (d.tools.added.length) lines.push(`  added   ${d.tools.added.join(", ")}`);
  if (d.tools.removed.length) lines.push(`  removed ${d.tools.removed.join(", ")}`);
  for (const a of d.tools.argChanges.slice(0, 5)) {
    const parts = a.changes
      .slice(0, 3)
      .map(
        (c) =>
          `${c.path || "(input)"}: ${cut(JSON.stringify(c.before) ?? "∅", 40)} → ${cut(JSON.stringify(c.after) ?? "∅", 40)}`,
      );
    lines.push(`  args    ${a.name} #${a.candidateStep + 1}: ${parts.join("; ")}`);
  }
  lines.push(
    `  answer  ${d.final.changed ? "CHANGED" : "same facts"}: key facts ${pct(d.final.factOverlap)} shared, wording ${pct(d.final.similarity)} alike (${d.final.baselineStop} → ${d.final.candidateStop})` +
      (d.final.missingFacts.length && !d.final.judge ? `; lost ${d.final.missingFacts.slice(0, 6).join(", ")}` : ""),
    `  cost    ${money(d.costUsd.baseline)} → ${money(d.costUsd.candidate)}${change(d.costUsd.baseline, d.costUsd.candidate)}` +
      `   time ${(d.latencyMs.baseline / 1000).toFixed(1)}s → ${(d.latencyMs.candidate / 1000).toFixed(1)}s` +
      billedNote(d),
  );
  if (d.final.judge) {
    const j = d.final.judge;
    lines.push(
      `  judge   ${j.verdict === "changed" ? "CHANGED" : "same"} (${j.model}): ${cut(j.reason, 160)}` +
        (j.lost.length ? `; lost: ${cut(j.lost.join("; "), 160)}` : ""),
    );
  } else if (d.final.judgeError)
    lines.push(`  judge   failed, kept the key-facts result: ${cut(d.final.judgeError, 120)}`);
  const tiers = Object.entries(d.replayTiers)
    .map(([t, n]) => `${t} ${n}`)
    .join(", ");
  if (tiers) lines.push(`  answered by: ${tiers}`);
  return lines.join("\n");
}

export function formatSummary(s: RunSummary, label: string): string {
  const v = s.verdicts;
  const tiers = Object.entries(s.replayTiers)
    .map(([t, n]) => `${t} ${n}`)
    .join(", ");
  return [
    `${label}: ${s.runs} runs replayed`,
    `  same ${v.same} · changed ${v.changed} · unreplayable ${v.unreplayable} · error ${v.error}`,
    `  tool path changed ${pct(s.toolPathChanged)} · arguments drifted ${pct(s.argumentsDrifted)} · final answer changed ${pct(s.answerChanged)}`,
    `  cost${s.excluded ? ` (of the ${s.runs - s.excluded} comparable runs)` : ""} ${money(s.costUsd.baseline)} → ${money(s.costUsd.candidate)}${change(s.costUsd.baseline, s.costUsd.candidate)}` +
      ` · time ${(s.latencyMs.baseline / 1000).toFixed(1)}s → ${(s.latencyMs.candidate / 1000).toFixed(1)}s${change(s.latencyMs.baseline, s.latencyMs.candidate)}`,
    ...(tiers ? [`  tool calls answered by: ${tiers}`] : []),
    ...(s.judge.judged || s.judge.failed
      ? [`  judge: ${s.judge.judged} answers ruled, ${s.judge.failed} failed, cost ${money(s.judge.costUsd)}`]
      : []),
    ...(s.runs > s.traces
      ? [
          `  ${s.traces} traces × ${Math.round(s.runs / s.traces)} replays: ${s.changedTraces} changed in most replays, ${s.flaky.length} flaky (same in some, changed in others)`,
          ...s.flaky
            .slice(0, 10)
            .map((f) => `    flaky ${f.baselineId}: changed ${f.changed}/${f.same + f.changed}  ${cut(f.task, 60)}`),
        ]
      : []),
  ].join("\n");
}
