# Judge calibration

TraceWarp has two ways to decide whether a replayed agent's final answer changed:

- **key-facts check** (default, free): compares numbers, codes and file names in the two answers.
- **Claude judge** (`--judge`): Claude reads the task and both answers and rules on substance (`src/judge.ts`).

This folder measures both against labelled answer pairs.

```bash
npx tsx evals/judge-calibration.ts                       # judge: claude-sonnet-5-5
npx tsx evals/judge-calibration.ts --model claude-haiku-5-5
npx tsx evals/judge-calibration.ts --pairs evals/heldout-pairs.jsonl --out evals/heldout-claude-sonnet-5-5.json
```

## The data

`answer-pairs.jsonl` has 85 pairs, all from the example file agent (`examples/file-agent.ts`) answering 15
payments-ops questions over `examples/demo-docs/`:

- **59 real pairs, labelled `same`.** Each is a recorded Claude Sonnet 5.5 answer next to a real replay of the same
  task. The replays come from four setups: no change, Claude Haiku 5.5, Claude Opus 5.5, and an edited system
  prompt. Every pair was read and labelled against the rubric below. None of the real replays changed the
  substance of the answer. This agent and these questions are easy, so a real regression never happened.
- **26 synthetic pairs, labelled `changed`.** Each is a real replayed answer with one realistic defect edited in:
  - a wrong number, limit or deadline (6);
  - a flipped conclusion (6);
  - a key instruction lost (5);
  - a wrong owner (4);
  - a give-up answer (3);
  - a contradiction (2).

  The `source` field names the defect and the pair it was edited from.

`heldout-pairs.jsonl` has the other 59 real replay pairs from the same runs. They were not looked at while the
judge prompt was written, and they were not hand-labelled: every pair is marked `same` because no real replay
regressed. They use the same 15 tasks and many of the same recorded answers as the labelled set, and 37 of them
are noise replays (no change). So they measure only one thing, the false-alarm rate on real replays similar to
the development data. They are not an independent accuracy test.

**Rubric.** A replay is `changed` when a user who asked this task would get a different fact, number, owner,
deadline or conclusion, or would lose something the task asked for or needs to act safely, or gets a refusal. Side
information the task did not ask for, rewording, order, and hedging are `same`.

The labels were written by Claude (the model that built TraceWarp), not by an independent person. Spot-check
them before you quote these numbers.

## Results (Nov 24, 2026)

| Check | Pairs | Accuracy | Precision (changed) | Recall (changed) | False alarms | Missed |
| --- | --- | --- | --- | --- | --- | --- |
| key-facts check | 85 labelled | 56.5% | 39.6% | 80.8% | 32 | 5 |
| Claude judge, first prompt (Sonnet 5.5), `calibration-first-prompt-*.json` | 85 labelled | 60.0% | 43.3% | 100% | 34 | 0 |
| **Claude judge, current prompt (Sonnet 5.5)** | 85 labelled | **98.8%** | **96.3%** | **100%** | 1 | 0 |
| Claude judge, current prompt (Haiku 5.5) | 85 labelled | 80.0% | 60.5% | 100% | 17 | 0 |
| key-facts check | 59 held-out real | false alarms on 23 of 59 (39%) | n/a | n/a | 23 | n/a |
| **Claude judge, current prompt (Sonnet 5.5)** | 59 held-out real | **false alarms on 0 of 59** | n/a | n/a | 0 | n/a |

What changed between the two prompts: the first prompt counted any dropped detail as a change. Real replays often
leave out side notes that the task never asked about, so it raised false alarms on 34 of 59 unchanged answers. The
current prompt first works out what the task asks, and judges only that.

The current prompt was written while looking at the 85 labelled pairs, so treat 98.8% as a development-set number.
The held-out run checks only that the judge stays quiet on unchanged real answers it was not tuned on; it says nothing about missed changes. Claude Sonnet 5.5 is the default judge model. Claude Haiku 5.5 is cheaper but
still too strict.

The full per-pair results are in `calibration-*.json` and `heldout-*.json`.
