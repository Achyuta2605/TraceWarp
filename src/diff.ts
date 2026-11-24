import { canonical, jsonChanges, keyFacts, overlap, type PathChange, textSimilarity } from "./json.js";
import type { Judgement } from "./judge.js";
import { cacheNeutralCostUsd } from "./pricing.js";
import { type ReplayTier, type ToolStep, type Trace, taskText } from "./trace.js";

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
  /** The user's request that started the task. */
  task: string;
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
    /** Set when a Claude judge ruled on the answer; it then decides `changed`. */
    judge?: Judgement;
    /** Set when the judge was asked but failed; `changed` is then the key-facts result. */
    judgeError?: string;
  };
  turns: { baseline: number; candidate: number };
  tokens: { baseline: { input: number; output: number }; candidate: { input: number; output: number } };
  /** Cache-neutral cost (see cacheNeutralCostUsd), so prompt caching cannot fake a saving. */
  costUsd: { baseline: number | null; candidate: number | null };
  /** What the two runs were billed, prompt cache included. */
  billedCostUsd: { baseline: number | null; candidate: number | null };
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

/**
 * Pairs the calls of two runs: the most calls with the same tool name, in order (a longest common subsequence),
 * and among those pairings the one with the most identical calls, so one extra read does not shift every later
 * read onto the wrong partner.
 */
function align(a: ToolStep[], b: ToolStep[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  // A name match outweighs any number of identical-input bonuses.
  const nameWeight = n + m + 1;
  const weight = (i: number, j: number) => {
    const x = a[i] as ToolStep;
    const y = b[j] as ToolStep;
    if (x.name !== y.name) return -1;
    return nameWeight + (key(x) === key(y) ? 1 : 0);
  };
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number) => (dp[i] as number[])[j] as number;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const w = weight(i, j);
      (dp[i] as number[])[j] = Math.max(at(i + 1, j), at(i, j + 1), w > 0 ? at(i + 1, j + 1) + w : 0);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const w = weight(i, j);
    if (w > 0 && at(i, j) === at(i + 1, j + 1) + w) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) i++;
    else j++;
  }
  return pairs;
}

/**
 * Calls the model asked for in one turn run in parallel, and their order inside the turn means nothing. The
 * candidate's calls in each turn are put in the baseline's order: identical calls first take the place of their
 * twin, then the rest fill the remaining places in their own order. A reordered batch is then no change, and one
 * changed read in a batch is one argument change, not a shuffle.
 */
function inBaselineOrder(baseline: ToolStep[], candidate: ToolStep[]): ToolStep[] {
  const turns = new Map<number, ToolStep[]>();
  for (const s of candidate) turns.set(s.turn, [...(turns.get(s.turn) ?? []), s]);
  const out: ToolStep[] = [];
  for (const [turn, calls] of [...turns.entries()].sort((x, y) => x[0] - y[0])) {
    const base = baseline.filter((s) => s.turn === turn);
    const left = [...calls];
    const placed: (ToolStep | undefined)[] = base.map((b) => {
      const i = left.findIndex((c) => key(c) === key(b));
      return i >= 0 ? left.splice(i, 1)[0] : undefined;
    });
    // Same tool next, so a changed Read takes the place of the Read it replaced.
    for (let k = 0; k < placed.length; k++) {
      if (placed[k]) continue;
      const i = left.findIndex((c) => c.name === base[k]?.name);
      if (i >= 0) placed[k] = left.splice(i, 1)[0];
    }
    for (let k = 0; k < placed.length && left.length; k++) if (!placed[k]) placed[k] = left.shift();
    out.push(...placed.filter((x): x is ToolStep => x !== undefined), ...left);
  }
  return out;
}

export function diffTraces(baseline: Trace, candidate: Trace): TraceDiff {
  const a = baseline.steps;
  const b = inBaselineOrder(a, candidate.steps);
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
    task: taskText(baseline),
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
    costUsd: {
      baseline: cacheNeutralCostUsd(baseline.request.model, baseline.usage),
      candidate: cacheNeutralCostUsd(candidate.request.model, candidate.usage),
    },
    billedCostUsd: { baseline: baseline.usage.costUsd, candidate: candidate.usage.costUsd },
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
  /** Judge rulings (when --judge is on): how many, how many failed and fell back to key facts, and their cost. */
  judge: { judged: number; failed: number; costUsd: number | null };
  /** Recorded traces in the batch. Each is replayed `runs / traces` times. */
  traces: number;
  /** Traces that changed in more than half of their replays: what --fail-on-change fails on. */
  changedTraces: number;
  /** Traces whose final answer changed in more than half of their replays: what --fail-on answer fails on. */
  answerChangedTraces: number;
  /**
   * Traces whose repeated replays disagreed (some same, some changed). A change on one of them may be noise, so
   * look at how often it changed before calling it a regression. Empty when each trace was replayed once.
   */
  flaky: Array<{ baselineId: string; task: string; same: number; changed: number }>;
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
  const judge: RunSummary["judge"] = { judged: 0, failed: 0, costUsd: 0 };
  for (const d of diffs) {
    verdicts[d.verdict]++;
    if (d.final.judge) {
      judge.judged++;
      const c = d.final.judge.usage?.costUsd;
      if (c === null) judge.costUsd = null;
      else if (c !== undefined && judge.costUsd !== null) judge.costUsd += c;
    }
    if (d.final.judgeError) judge.failed++;
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
    judge,
    ...byTrace(diffs),
  };
}

function byTrace(diffs: TraceDiff[]): Pick<RunSummary, "traces" | "changedTraces" | "answerChangedTraces" | "flaky"> {
  const groups = new Map<string, TraceDiff[]>();
  for (const d of diffs) groups.set(d.baselineId, [...(groups.get(d.baselineId) ?? []), d]);
  let changedTraces = 0;
  let answerChangedTraces = 0;
  const flaky: RunSummary["flaky"] = [];
  for (const [baselineId, ds] of groups) {
    const changed = ds.filter((d) => d.verdict === "changed").length;
    const same = ds.filter((d) => d.verdict === "same").length;
    if (changed > ds.length / 2) changedTraces++;
    const answers = ds.filter((d) => d.verdict === "changed" && d.final.changed).length;
    if (answers > ds.length / 2) answerChangedTraces++;
    if (changed && same) flaky.push({ baselineId, task: ds[0]?.task ?? "", same, changed });
  }
  return { traces: groups.size, changedTraces, answerChangedTraces, flaky };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
