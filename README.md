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

# 3. Measure the noise: replay with no change. Real models vary run to run, so this tells you
#    how much difference to expect even when nothing changed.
tracewarp replay --all
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

## How tool calls are answered

The replayed model runs its own loop from the recorded starting messages. Each tool call it makes goes down these
tiers, and every step in the report says which one answered it:

1. **exact**: the same call (same tool, same arguments) is in the recording.
2. **fuzzy**: a close call is in the recording (same tool, arguments at least 85% alike), e.g. `"paris "` vs `"Paris"`.
3. **live**: the tool is marked read-only in `tracewarp.yaml` and connected to a real MCP server, so it is safe to
   call for real.
4. **simulated**: off by default. A cheap model (Claude Haiku 5.5) writes a plausible result from the tool's
   definition and the recorded examples.
5. **unreplayable**: nothing could answer it. By default the run stops here and is reported as unreplayable,
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
- **cost and time**, priced from the token usage of each turn.

And for a batch: how many runs stayed the same, changed or could not be replayed, and the share whose tool path
changed, whose arguments drifted and whose answer changed. Each run is saved under `.tracewarp/runs/<id>/`.

## AgentOverwatch

If your MCP servers run behind AgentOverwatch, `tracewarp import-overwatch` reads its log (read-only) and tags each
recorded tool call with the MCP server that handled it, the server's own latency, and whether the gateway blocked
the call.

## Commands

| Command | What it does |
| --- | --- |
| `tracewarp record [-- <cmd>]` | Run an agent through a local recording proxy (or start the proxy on its own). |
| `tracewarp list` | List recorded traces. |
| `tracewarp show <trace>` | One trace: task, tool calls, final answer. |
| `tracewarp replay [traces...] --all` | Replay with a change and print the diff of every run plus a summary. |
| `tracewarp diff <a> <b>` | Compare any two traces. |
| `tracewarp import-overwatch` | Attach AgentOverwatch server data to recorded calls. |
| `tracewarp init` | Write a starter `tracewarp.yaml`. |

Traces are plain JSON files in `.tracewarp/traces/` (override with `--dir` or `TRACEWARP_DIR`). They contain your
prompts and tool results, so treat them like logs: keep them out of git unless they hold nothing private.

## Limits (today)

- Claude Messages API traffic only.
- Replay re-runs the agent loop from the recorded request. Changes inside your agent's own code (a new planning
  step, a different memory setup) are not replayed yet. Calling your agent with mocked MCP tools is planned.
- Final-answer comparison is a deterministic heuristic. A Claude judge, checked against human labels, comes next.

## Development

```bash
npm install
npm test          # build + 44 tests, no network or API key needed
npm run lint && npm run typecheck
```

`examples/file-agent.ts` is a small real agent (three file tools) used by the tests and the demo, with
`examples/demo-docs/` and `examples/demo-tasks.txt` as its data.

## License

Apache 2.0
