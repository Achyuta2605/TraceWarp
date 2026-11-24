/**
 * Measures how well the two answer checks agree with human labels.
 *
 *   npx tsx evals/judge-calibration.ts [--model claude-sonnet-5-5] [--pairs evals/answer-pairs.jsonl] [--out file.json]
 *
 * Each line of the pairs file is one recorded answer, one replayed answer of the same task, and the label a person
 * gave it: "same" (the replay still tells the user the same thing) or "changed". Prints accuracy, precision and
 * recall (for "changed") of the key-facts check and of the Claude judge, plus every disagreement.
 * Needs TRACEWARP_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY; judgements are cached in evals/.judge-cache.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerChanged } from "../src/diff.js";
import { ClaudeJudge, DEFAULT_JUDGE_MODEL } from "../src/judge.js";
import { AnthropicProvider } from "../src/provider.js";

interface Pair {
  id: string;
  task: string;
  baseline: string;
  candidate: string;
  label: "same" | "changed";
  source: string;
  note?: string;
}

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] as string) : fallback;
};
const here = import.meta.dirname;
const model = arg("--model", DEFAULT_JUDGE_MODEL);
const pairs = readFileSync(arg("--pairs", join(here, "answer-pairs.jsonl")), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Pair);

const judge = new ClaudeJudge(new AnthropicProvider(), { model, cachePath: join(here, ".judge-cache.json") });

interface Score {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}
const score = (): Score => ({ tp: 0, fp: 0, tn: 0, fn: 0 });
function add(s: Score, predicted: boolean, actual: boolean) {
  if (predicted && actual) s.tp++;
  else if (predicted) s.fp++;
  else if (actual) s.fn++;
  else s.tn++;
}
function report(name: string, s: Score) {
  const n = s.tp + s.fp + s.tn + s.fn;
  const precision = s.tp + s.fp ? s.tp / (s.tp + s.fp) : 1;
  const recall = s.tp + s.fn ? s.tp / (s.tp + s.fn) : 1;
  console.log(
    `${name.padEnd(22)} accuracy ${((100 * (s.tp + s.tn)) / n).toFixed(1)}%  precision ${(100 * precision).toFixed(1)}%  recall ${(100 * recall).toFixed(1)}%  (false alarms ${s.fp}, missed ${s.fn})`,
  );
  return { name, ...s, accuracy: (s.tp + s.tn) / n, precision, recall };
}

const facts = score();
const claude = score();
const rows: unknown[] = [];
let i = 0;
const queue = [...pairs];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const actual = p.label === "changed";
      const h = answerChanged(p.baseline, p.candidate).changed;
      const j = await judge.judge({ task: p.task, baseline: p.baseline, candidate: p.candidate });
      add(facts, h, actual);
      add(claude, j.verdict === "changed", actual);
      rows.push({ id: p.id, source: p.source, label: p.label, facts: h ? "changed" : "same", judge: j.verdict, reason: j.reason });
      process.stderr.write(`\r${++i}/${pairs.length}`);
    }
  }),
);
process.stderr.write("\n");
const counts = { same: pairs.filter((p) => p.label === "same").length, changed: pairs.filter((p) => p.label === "changed").length };
console.log(`${pairs.length} labelled pairs (${counts.same} same, ${counts.changed} changed), judge ${model}\n`);
const results = [report("key-facts check", facts), report(`Claude judge`, claude)];
console.log("\nJudge disagreements with the label:");
for (const r of rows as Array<{ id: string; label: string; judge: string; reason: string }>) {
  if (r.label !== r.judge) console.log(`  ${r.id}: label ${r.label}, judge ${r.judge}: ${r.reason}`);
}
writeFileSync(arg("--out", join(here, `calibration-${model}.json`)), `${JSON.stringify({ model, counts, results, rows }, null, 2)}\n`);
