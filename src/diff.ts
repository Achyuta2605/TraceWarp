import { canonical, jsonChanges, keyFacts, overlap, type PathChange, textSimilarity } from "./json.js";
import type { ReplayTier, ToolStep, Trace } from "./trace.js";

/**
 * Compares a recorded run (baseline) with its replay (candidate): which tools were called, with what arguments,
 * where the two runs first went different ways, how the final answer changed, and what it cost.
 */

export type DivergenceKind = "tool" | "arguments" | "extra_call" | "missing_call" | "final_answer" | "stop_reason";

export interface Divergence {
  /** Index into the tool-call sequence (or the count of calls, for the final answer). */
  step: number;
  kind: DivergenceKind;
  baseline?: string;
  candidate?: string;
}

export interface ArgChange {
  baselineStep: number;
  candidateStep: number;
  name: string;
  changes: PathChange[];
}

export type Verdict = "same" | "changed" | "unreplayable" | "error";

export interface TraceDiff {
  baselineId: string;
  candidateId: string;
  verdict: Verdict;
  firstDivergence: Divergence | null;
  tools: {
    baseline: string[];
    candidate: string[];
    /** Calls only the candidate made (by name, in order). */
    added: string[];
    /** Calls only the baseline made. */
    removed: string[];
    argChanges: ArgChange[];
    sameSequence: boolean;
  };
  final: {
    /** Wording similarity, 0-1. Low even for equivalent answers, so it only decides when there are no facts. */
    similarity: number;
    /** Overlap of key facts (numbers, codes, file names), 0-1. */
    factOverlap: number;
    /** Facts in the recorded answer that the replay's answer lacks. */
    missingFacts: string[];
    /** Facts only the replay's answer has. */
    newFacts: string[];
    /** Whether the answer counts as changed (see answerChanged). */
    changed: boolean;
    baselineStop: string | null;
    candidateStop: string | null;
    baselineText: string;
    candidateText: string;
  };
  turns: { baseline: number; candidate: number };
  tokens: { baseline: { input: number; output: number }; candidate: { input: number; output: number } };
  costUsd: { baseline: number | null; candidate: number | null };
  latencyMs: { baseline: number; candidate: number };
  replayTiers: Partial<Record<ReplayTier, number>>;
  status: { baseline: Trace["status"]; candidate: Trace["status"] };
}

/** Answers sharing at least this share of key facts count as the same answer (until a judge says otherwise). */
export const SAME_FACTS_THRESHOLD = 0.8;
/** For answers with no key facts at all, the wording similarity needed to count as the same. */
export const SAME_TEXT_THRESHOLD = 0.5;

/**
 * A cheap, deterministic check of whether the final answer changed in substance. Measured on real runs replayed
 * with no change, wording similarity fell as low as 0.62 while key facts stayed at 0.87 or above.
 */
export function answerChanged(
  baseline: string,
  candidate: string,
): {
  changed: boolean;
  similarity: number;
  factOverlap: number;
  missingFacts: string[];
  newFacts: string[];
} {
  const similarity = round(textSimilarity(baseline, candidate));
  const a = keyFacts(baseline);
  const b = keyFacts(candidate);
  const factOverlap = round(overlap(a, b));
  const changed = a.size || b.size ? factOverlap < SAME_FACTS_THRESHOLD : similarity < SAME_TEXT_THRESHOLD;
  return {
    changed,
    similarity,
    factOverlap,
    missingFacts: [...a].filter((f) => !b.has(f)),
    newFacts: [...b].filter((f) => !a.has(f)),
  };
}

const key = (s: ToolStep) => `${s.name}\u0000${canonical(s.input)}`;

/** Longest common subsequence of two lists by tool name, as index pairs. */
function align(a: ToolStep[], b: ToolStep[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i] as number[];
      row[j] =
        a[i]?.name === b[j]?.name
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i]?.name === b[j]?.name) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number)) i++;
    else j++;
  }
  return pairs;
}

export function diffTraces(baseline: Trace, candidate: Trace): TraceDiff {
  const a = baseline.steps;
  const b = candidate.steps;
  const pairs = align(a, b);
  const pairedA = new Set(pairs.map(([i]) => i));
  const pairedB = new Set(pairs.map(([, j]) => j));
  const argChanges: ArgChange[] = [];
  for (const [i, j] of pairs) {
    const changes = jsonChanges((a[i] as ToolStep).input, (b[j] as ToolStep).input);
    if (changes.length) argChanges.push({ baselineStep: i, candidateStep: j, name: (a[i] as ToolStep).name, changes });
  }
  const sameSequence = a.length === b.length && a.every((s, i) => key(s) === key(b[i] as ToolStep));

  let firstDivergence: Divergence | null = null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x && y && x.name !== y.name) firstDivergence = { step: i, kind: "tool", baseline: x.name, candidate: y.name };
    else if (x && y && key(x) !== key(y)) {
      firstDivergence = { step: i, kind: "arguments", baseline: canonical(x.input), candidate: canonical(y.input) };
    } else if (x && !y) firstDivergence = { step: i, kind: "missing_call", baseline: x.name };
    else if (!x && y) firstDivergence = { step: i, kind: "extra_call", candidate: y.name };
    if (firstDivergence) break;
  }

  const answer = answerChanged(baseline.final.text, candidate.final.text);
  if (!firstDivergence && baseline.final.stopReason !== candidate.final.stopReason) {
    firstDivergence = {
      step: a.length,
      kind: "stop_reason",
      baseline: String(baseline.final.stopReason),
      candidate: String(candidate.final.stopReason),
    };
  }
  if (!firstDivergence && answer.changed) {
    firstDivergence = { step: a.length, kind: "final_answer" };
  }

  const replayTiers: Partial<Record<ReplayTier, number>> = {};
  for (const s of b) if (s.replay) replayTiers[s.replay.tier] = (replayTiers[s.replay.tier] ?? 0) + 1;

  let verdict: Verdict = firstDivergence ? "changed" : "same";
  if (candidate.status === "error") verdict = "error";
  else if (candidate.status === "unreplayable") verdict = "unreplayable";

  return {
    baselineId: baseline.id,
    candidateId: candidate.id,
    verdict,
    firstDivergence,
    tools: {
      baseline: a.map((s) => s.name),
      candidate: b.map((s) => s.name),
      added: b.filter((_, j) => !pairedB.has(j)).map((s) => s.name),
      removed: a.filter((_, i) => !pairedA.has(i)).map((s) => s.name),
      argChanges,
      sameSequence,
    },
    final: {
      ...answer,
      baselineStop: baseline.final.stopReason,
      candidateStop: candidate.final.stopReason,
      baselineText: baseline.final.text,
      candidateText: candidate.final.text,
    },
    turns: { baseline: baseline.final.turns, candidate: candidate.final.turns },
    tokens: {
      baseline: { input: baseline.usage.inputTokens, output: baseline.usage.outputTokens },
      candidate: { input: candidate.usage.inputTokens, output: candidate.usage.outputTokens },
    },
    costUsd: { baseline: baseline.usage.costUsd, candidate: candidate.usage.costUsd },
    latencyMs: { baseline: baseline.usage.latencyMs, candidate: candidate.usage.latencyMs },
    replayTiers,
    status: { baseline: baseline.status, candidate: candidate.status },
  };
}

export interface RunSummary {
  runs: number;
  verdicts: Record<Verdict, number>;
  /** Share of comparable runs (not error/unreplayable) whose tool path changed: other tools, order or count. */
  toolPathChanged: number;
  /** Share of comparable runs with the same tools in the same order but different arguments somewhere. */
  argumentsDrifted: number;
  /** Share of comparable runs whose final answer changed in substance (see answerChanged). */
  answerChanged: number;
  /** Runs that ended in error or unreplayable, left out of the shares, cost and time. */
  excluded: number;
  /** Cost and time of the comparable runs only, so a replay cut short does not look cheap. */
  costUsd: { baseline: number | null; candidate: number | null };
  latencyMs: { baseline: number; candidate: number };
  replayTiers: Partial<Record<ReplayTier, number>>;
}

export function summarize(diffs: TraceDiff[]): RunSummary {
  const verdicts: Record<Verdict, number> = { same: 0, changed: 0, unreplayable: 0, error: 0 };
  let path = 0;
  let args = 0;
  let answer = 0;
  let comparable = 0;
  let cb: number | null = 0;
  let cc: number | null = 0;
  let lb = 0;
  let lc = 0;
  const tiers: Partial<Record<ReplayTier, number>> = {};
  for (const d of diffs) {
    verdicts[d.verdict]++;
    if (d.verdict === "same" || d.verdict === "changed") {
      comparable++;
      const names = d.tools.baseline.join("\u0000") === d.tools.candidate.join("\u0000");
      if (!names) path++;
      else if (!d.tools.sameSequence) args++;
      if (d.final.changed) answer++;
      cb = cb === null || d.costUsd.baseline === null ? null : cb + d.costUsd.baseline;
      cc = cc === null || d.costUsd.candidate === null ? null : cc + d.costUsd.candidate;
      lb += d.latencyMs.baseline;
      lc += d.latencyMs.candidate;
    }
    for (const [t, n] of Object.entries(d.replayTiers)) tiers[t as ReplayTier] = (tiers[t as ReplayTier] ?? 0) + n;
  }
  const share = (n: number) => (comparable ? round(n / comparable) : 0);
  return {
    runs: diffs.length,
    verdicts,
    toolPathChanged: share(path),
    argumentsDrifted: share(args),
    answerChanged: share(answer),
    excluded: diffs.length - comparable,
    costUsd: { baseline: cb, candidate: cc },
    latencyMs: { baseline: lb, candidate: lc },
    replayTiers: tiers,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
