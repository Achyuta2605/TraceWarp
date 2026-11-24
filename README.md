# TraceWarp

**Before you change your agent, see exactly what breaks.**

TraceWarp records real runs of your AI agent: every model turn, every tool call and every tool result. When you
want to change something (switch to a new model, edit the system prompt, rewrite a tool description, change
settings), it replays those same runs with the change. Tool calls are answered from the recording, so nothing
real is touched. Then it shows you, run by run, where the new version first went a different way.

```
$ tracewarp replay --all --model claude-haiku-5-5

tw_mwudr093bf1d6f66 → rp_mwudrfote083bc12: CHANGED  (step 2: called read_file instead of search)
  tools   list_files → search → search → read_file → read_file
  replay  list_files → read_file → search
  answer  same facts: key facts 100% shared, wording 47% alike (end_turn → end_turn)
  cost    $0.011 → $0.0005 (-96%)   time 4.7s → 2.6s
  answered by: exact 3

Run run_mwudrckv599a01d6: 5 runs replayed
  same 0 · changed 2 · unreplayable 3 · error 0
  tool path changed 100% · arguments drifted 0% · final answer changed 50%
  cost $0.037 → $0.0013 (-96%) · time 15.5s → 7.0s (-55%)
```

It is the sister project of [AgentOverwatch](https://github.com/Achyuta2605/AgentOverwatch), the security gateway
for MCP tools, and can read its call log.

## Why

Every team running agents hits the same wall when a new model ships or a prompt needs a fix: *will this break the
things that already work?* Eval platforms score single answers well, but an agent is a path: which tools it picks,
with which arguments, in which order. A model that answers correctly but stops reading the runbook first is a
regression you want to see before your users do.

TraceWarp tests that path on **your real traffic**, not a hand-written test set, and it is honest about what it
could not replay.

## Quick start

Requires Node 22.12+.

```bash
npm install -g tracewarp

# 1. Record. Any agent that reads ANTHROPIC_BASE_URL works unchanged
#    (the Anthropic SDKs, the Claude Agent SDK, Claude Code).
tracewarp record -- node my-agent.js "What does the refund runbook say about R-500?"
tracewarp list

# 2. Replay with a change. Needs an API key: TRACEWARP_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY.
tracewarp replay --all --model claude-sonnet-5-5
tracewarp replay --all --system new-prompt.txt
tracewarp replay --all --tool-desc search=search-v2.txt --param 'output_config={"effort":"low"}'

# 3. Measure the noise: replay with no change, twice per trace. Real models vary run to run, so this
#    tells you how much difference to expect even when nothing changed.
tracewarp replay --all --repeat 2

# 4. Let Claude judge the final answers instead of the free key-facts check (see "Judging answers").
tracewarp replay --all --model claude-haiku-5-5 --judge --fail-on-change --fail-on answer

# 5. Open the report of the last run.
tracewarp report
```

Recording in your own code instead of through the proxy:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { Recorder, recordingFetch } from "tracewarp";

const recorder = new Recorder({ source: "sdk", label: "support-bot" });
const client = new Anthropic({ fetch: recordingFetch(recorder) });
```

## What a replay can change

| Change | Flag |
| --- | --- |
| Model | `--model claude-opus-5-5` |
| System prompt | `--system prompt.txt` |
| A tool's description | `--tool-desc name=file.txt` (repeatable) |
| Which tools exist | `--remove-tool name` (repeatable) |
| Any request setting | `--param max_tokens=8000`, `--param 'output_config={"effort":"high"}'` |

When you move to a model that rejects settings the old one took (sampling settings on Claude Opus 5.5, disabled
thinking, forced `tool_choice`), TraceWarp drops or rewrites them and prints a note, instead of failing every run.

### In CI

```bash
tracewarp replay --all --model claude-sonnet-5-5 --fail-on-change
```

Exit codes: `0` done, `1` a run changed (only with `--fail-on-change`), `2` a replay failed with an error or every
judge call failed, `3` bad input (a missing key, a bad config, an unknown option, no traces). With
`--fail-on answer`, only a changed final answer fails the run; a new tool path alone does not. A run
stops early if the API refuses the key. Traces that did not finish when recorded are skipped unless you pass
`--include-incomplete`.

Calls go to `TRACEWARP_UPSTREAM`, else the `ANTHROPIC_BASE_URL` your agent would have used (a company gateway, for
example), else `https://api.anthropic.com`. The recording keeps `anthropic-beta` headers so a replay sends the same
beta flags; API keys are never written to a trace.

## How tool calls are answered

The replayed model runs its own loop from the recorded starting messages. Each tool call it makes goes down these
tiers, and every step in the report says which one answered it:

1. **exact**: the same call (same tool, same arguments) is in the recording.
2. **denied**: the tool is set to `deny: true` (or `--deny-tool`), so the call gets a permission error, as it
   would have when the agent was not allowed to use it.
3. **live**: the tool is marked read-only in `tracewarp.yaml` and connected to a real MCP server, or it is one of
   Claude Code's read tools with `--claude-code-tools`, so it is safe to call for real. A live tool skips fuzzy
   matching: the true answer beats a recorded one for a similar call.
4. **fuzzy**: a close call is in the recording (same tool, arguments at least 85% alike), e.g. `"paris "` vs
   `"Paris"`. Numbers, ids, codes and paths must match exactly: `R-500` never answers for `R-501`.
5. **simulated**: off by default. A cheap model (Claude Haiku 5.5) writes a plausible result from the tool's
   definition and the recorded examples.
6. **unreplayable**: nothing could answer it. By default the run stops here and is reported as unreplayable,
   rather than letting the model continue on a made-up result and calling the run "changed".

```yaml
# tracewarp.yaml (tracewarp init writes a starter)
replay:
  fuzzyThreshold: 0.85
  onMiss: stop          # or continue: the model gets an error result and carries on
  simulate: false
servers:
  fs: { command: [npx, -y, "@modelcontextprotocol/server-filesystem", "."] }
tools:
  mcp__fs__read_text_file: { readOnly: true, live: fs }
  Bash: { deny: true }  # a permission error, as the recorded session would have got
builtins:
  claudeCode: { enabled: true }  # Claude Code's Read/Grep/Glob/LS, read-only, in the recorded folder
```

Live calls are only allowed for tools marked `readOnly: true`; the config is rejected otherwise.

## What the diff reports

For every run:

- **first divergence**: the first step where the replay did something different: another tool, other arguments,
  an extra call, a missing call, or a different ending.
- **tool path**: both call sequences, aligned, with the calls added and removed and the exact argument changes.
- **final answer**: whether it changed *in substance*. Wording always varies between runs, so TraceWarp compares
  the key facts (numbers, codes, file names) and lists any the new answer lost. In our measurements, unchanged
  replays shared 87-100% of key facts while their wording was only 62-100% alike.
- **cost and time**, priced from the token usage of each turn. Cost is compared without the prompt cache (every
  input token at the uncached price), and the billed cost is shown too when caching made it differ.
- **tool path** treats the calls of one turn as a set, so parallel calls that come back in another order are not
  a change.
- **the judge's ruling**, when `--judge` is on: same or changed, one sentence why, and what the replay lost.

And for a batch: how many runs stayed the same, changed or could not be replayed, and the share whose tool path
changed, whose arguments drifted and whose answer changed. Cost and time totals count only the runs that could be
compared, so a replay that stopped early never looks cheap. With `--repeat`, a trace that came out the same in some
replays and changed in others is listed as **flaky**, and `--fail-on-change` only fails on a trace that changed in
most of its replays.

Each run is saved under `.tracewarp/runs/<id>/`: the replayed traces, `diffs.json`, `summary.json`, a
self-contained `report.html` (summary cards, then every run with both tool paths and both answers side by side)
and a `summary.md` for a CI job summary or PR comment.

## Case study

We moved a real docs agent from Claude Sonnet 5.5 to Haiku 5.5 and to Opus 5.5, and edited its prompt. That came
to 30 recorded runs and 180 replays ([docs/case-study.md](docs/case-study.md)). The results:
- Haiku 5.5 kept the substance of every answer at 95% lower cost.
- Opus 5.5 cost 94% more for the same answers, with 26% fewer tool calls.
- Read-only live tools turned 18 unreplayable Haiku runs into answered ones.
- On pure noise, the key-facts check raised false alarms on 12% of runs. The judge raised none.

## Claude Code and the Agent SDK

Claude Code and the Claude Agent SDK read `ANTHROPIC_BASE_URL`, so `tracewarp record` captures them like any
other agent:

```bash
tracewarp record --label cc -- claude -p "Who can switch to the backup gateway?" --allowedTools "Read,Grep,Glob"
tracewarp replay --label cc --agents-only --claude-code-tools --deny-tool Bash --model claude-haiku-5-5 --judge
```

- `--agents-only` skips the side calls Claude Code makes on its own (titles, memory selection, summaries).
- `--claude-code-tools [folder]` runs Read, Grep, Glob and LS for real, read-only, inside the folder the session
  worked in. A new model reads files the recording never opened, so without this most replays stop as
  unreplayable. These are TraceWarp's own implementations of the tools, close to Claude Code's output but not
  byte-identical.
- `--deny-tool Bash` answers any Bash call with a permission error, which is what a session recorded with
  `--allowedTools` would have got. TraceWarp never runs Bash.
- Tools that Claude Code loads on demand (MCP tools found with ToolSearch) are recorded and offered again when
  the replayed model searches for them.
- Cost is compared without the prompt cache. A replay reads the cache its recording just wrote and would
  otherwise look about 80% cheaper than it is. The billed cost is shown next to it.

On a small Agent SDK agent with a custom MCP tool, Haiku 5.5 cut cost by 94%, but in 5 of 6 runs it never loaded
the MCP tool it needed, and those answers lost the service owner. Unchanged replays changed 0 of 6 answers. Details:
[docs/claude-code.md](docs/claude-code.md).

## Judging answers

Wording changes every run, so "did the answer change?" needs care. TraceWarp has two checks:

- **key-facts check** (default, free, instant): compares the numbers, codes and file names in both answers.
- **Claude judge** (`--judge`, or `judge: { enabled: true }` in `tracewarp.yaml`): Claude Sonnet 5.5 reads the
  task and both answers and decides whether a user who asked this task would be just as well served. It ignores
  wording and side notes the task never asked about. It flags a different fact, number, owner, deadline or
  conclusion, a lost instruction the task needs, and a give-up answer. Rulings are cached, so re-running costs
  nothing. Pick another judge model with `--judge-model`; turn it off for one run with `--no-judge`.

Measured on 85 labelled answer pairs from real replays ([evals/](evals/README.md)):

| Check | Accuracy | False alarms | Missed changes |
| --- | --- | --- | --- |
| key-facts check | 56.5% | 32 of 59 | 5 of 26 |
| Claude judge (Sonnet 5.5) | 98.8% | 1 of 59 | 0 of 26 |

On 59 more real replays that were kept out while the judge prompt was written, the judge raised 0 false alarms and
the key-facts check raised 23. The changed pairs are realistic defects edited into real answers, because none of the
real replays regressed, and Claude wrote the labels. Details and caveats are in [evals/README.md](evals/README.md).

## In CI

`action.yml` makes TraceWarp a GitHub Action: on a pull request that edits your prompt or settings, it replays the
recorded traces with the change, writes the summary to the job page, uploads the HTML report, and fails the check
when a trace changed. See [docs/github-action.md](docs/github-action.md).

## AgentOverwatch

If your MCP servers run behind AgentOverwatch, `tracewarp import-overwatch` reads its log (read-only) and tags each
recorded tool call with the MCP server that handled it, the server's own latency, and whether the gateway blocked
the call. It needs the optional `better-sqlite3` package, which npm installs when it can build it.

## Commands

| Command | What it does |
| --- | --- |
| `tracewarp record [-- <cmd>]` | Run an agent through a local recording proxy (or start the proxy on its own). |
| `tracewarp list` | List recorded traces. |
| `tracewarp show <trace>` | One trace: task, tool calls, final answer. |
| `tracewarp replay [traces...] --all` | Replay with a change and print the diff of every run plus a summary. |
| `tracewarp diff <a> <b>` | Compare any two traces. |
| `tracewarp report [run]` | Rebuild and show the HTML report (or `--md` summary) of a replay run. |
| `tracewarp import-overwatch` | Attach AgentOverwatch server data to recorded calls. |
| `tracewarp init` | Write a starter `tracewarp.yaml`. |

Traces are plain JSON files in `.tracewarp/traces/` (override with `--dir` or `TRACEWARP_DIR`). They contain your
prompts and tool results, so treat them like logs: keep them out of git unless they hold nothing private.

## Limits (today)

- Claude Messages API traffic only (Claude Code and the Agent SDK included).
- Replay re-runs the agent loop from the recorded request. Changes inside your agent's own code (a new planning
  step, a different memory setup) are not replayed yet. Calling your agent with mocked MCP tools is planned.
- The judge was calibrated on one agent and one kind of task (ops questions over docs). Check it on a sample of
  your own traffic with `evals/judge-calibration.ts` before trusting it on a very different agent.

## Development

```bash
npm install
npm test          # build + 108 tests, no network or API key needed
npm run lint && npm run typecheck
```

`examples/file-agent.ts` is a small real agent (three file tools) used by the tests, the demo and the case study,
with `examples/demo-docs/` and `examples/demo-tasks.txt` as its data. `examples/agent-sdk/` is a Claude Agent SDK
agent with a custom MCP tool; it has its own `package.json` because the SDK is large. `examples/docs-mcp-server.ts` serves the same
tools over MCP, and `examples/tracewarp.yaml` lets a replay call them live.

## License

Apache 2.0
