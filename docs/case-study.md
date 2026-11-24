# Case study: moving a docs agent to a new model, and editing its prompt

*Real API runs, November 24, 2026. The agent, data and commands are in this repo, so you can re-run every number.*

## The setup

- **Agent:** `examples/file-agent.ts`, a real Claude agent with three read-only tools (`list_files`, `read_file`,
  `search`) that answers questions over a folder.
- **Data:** a payments team's runbooks and policies (`examples/demo-docs/`, 7 files).
- **Tasks:** 15 on-call questions (`examples/demo-tasks.txt`), such as "The payment gateway is failing 8% of calls.
  What do we do, and who can switch to the backup?"
- **Baseline:** each task run twice on Claude Sonnet 5.5 and recorded with `tracewarp record`. That gives 30 traces
  with 116 tool calls.
- **Judging:** every replay was judged by the calibrated Claude judge (`--judge`, Sonnet 5.5). The key-facts check
  is shown next to it for comparison. (The replays were judged before the judge's input was switched to
  JSON to resist prompt injection. The calibration was re-run after that change and the Sonnet 5.5 numbers did not move.)
- **Live tools:** the replays marked "live" used `examples/tracewarp.yaml`. When a replay made a call the recording
  never saw, it was answered by the real read-only tools through `examples/docs-mcp-server.ts`.

## Results

| Replay | Runs | Same | Changed | Unreplayable | Answer changed (judge) | Key-facts check would say | Cost | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| No change, ×2 (noise) | 60 | 52 | 4 | 4 | 0 of 56 | 7 of 56 | -1% | -23% |
| Claude Haiku 5.5, recording only | 30 | 2 | 10 | **18** | 0 of 12 | 10 of 12 | -95% | -51% |
| Claude Haiku 5.5, live tools | 30 | 5 | 25 | 0 | 0 of 30 | 18 of 30 | **-95%** | -43% |
| Claude Opus 5.5, live tools | 30 | 0 | 30 | 0 | 0 of 30 | 14 of 30 | **+94%** | +51% |
| Prompt edit, live tools | 30 | 21 | 9 | 0 | 0 of 30 | 20 of 30 | -14% | -44% |

"Changed" here is the verdict on the whole run, so a different tool path counts. "Answer changed" is the judge's
ruling on the final answer alone. The prompt edit replaced "Use the tools to look before you answer. Keep the
answer short." with "Answer in one sentence."

## What we learned

**1. Measure the noise before you trust a diff.** With nothing changed, 4 of 60 replays took a different tool path
and 4 more made a call the recording could not answer. The key-facts check called 7 unchanged answers "changed",
which is a 12% false-alarm rate on pure noise. The judge called none.

**2. Without live tools, a model switch is mostly unreplayable.** On recordings alone, 18 of 30 Haiku replays hit a
tool call that had never been recorded and were stopped. Marking the three read-only tools `live` brought that to 0,
with 23 calls answered for real. This is why TraceWarp stops instead of guessing: a made-up tool result would have
made those 18 runs look "changed" for the wrong reason.

**3. A new model takes a new path, and that is often fine.** Opus 5.5 changed the tool path in all 30 runs. It made
26% fewer calls (86 vs 116), usually skipping `list_files`, and its answers kept the same substance in every case.
For a model migration, gate on the answer (`--fail-on answer`) and read the path changes as information rather than
as failures.

**4. Cost moves more than quality here.**
- Haiku 5.5 kept every answer's substance at 5% of the cost.
- Opus 5.5 cost 94% more for the same answers.
- The prompt edit made answers about half as long (263 vs 542 characters on average) and cut 44% of the time, with
  the same substance.

On this agent and these questions, Haiku 5.5 is the clear choice. A team would want the same check on its own,
harder tasks before switching.

**5. The key-facts check is too noisy to gate on by itself.** It flagged 7 to 20 runs per setup. Each of these was
a shorter or reworded answer that the judge ruled to be the same, and the 85 hand-checked pairs in `evals/` agree
with the judge. Use the key-facts check for a free first pass, and use `--judge` to decide.

## The limits of this study

- It covers one small agent, one kind of task, and easy questions over 7 files. The agent never regressed in
  substance, so the judge's recall here comes from the synthetic pairs in `evals/`, not from these runs.
- Tool-path noise (point 1) was measured with 2 replays per trace. More repeats would give tighter numbers.
- Judge calls cost extra and are not counted in the table.

## Re-running it

```bash
export ANTHROPIC_API_KEY=...            # or TRACEWARP_ANTHROPIC_API_KEY
for i in 1 2; do while read -r q; do
  tracewarp --dir cs record -- node --import tsx examples/file-agent.ts examples/demo-docs "$q"
done < examples/demo-tasks.txt; done
tracewarp --dir cs replay --all --repeat 2 --judge
tracewarp --dir cs replay --all --model claude-haiku-5-5 --judge -c examples/tracewarp.yaml
tracewarp --dir cs replay --all --model claude-opus-5-5 --judge -c examples/tracewarp.yaml
tracewarp --dir cs report               # opens the latest report.html path
```
