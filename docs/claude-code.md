# Replaying Claude Code and Claude Agent SDK runs

*Real API runs, November 24, 2026, Claude Code 2.1.331 and Agent SDK 0.3.331.*

Claude Code and the Claude Agent SDK send their Claude calls to `ANTHROPIC_BASE_URL`, so `tracewarp record`
captures them with no code changes. A replay then needs three things Claude Code has and a plain API agent
doesn't. This page shows them, and what we found when we replayed real sessions.

## Recording

```bash
cd my-project
tracewarp record --label cc -- claude -p "Who can switch to the backup gateway?" \
  --model claude-sonnet-5-5 --allowedTools "Read,Grep,Glob"
tracewarp list
```

One `claude -p` run makes several API calls. TraceWarp groups them into traces by conversation: the agent loop
itself, plus side calls Claude Code makes on its own (picking memories, writing a session title, summarising
tool use). The side calls offer no tools, and `--agents-only` leaves them out of a replay.

An Agent SDK agent records the same way. `examples/agent-sdk/` is one: an on-call agent that reads a docs
folder and asks a custom in-process MCP tool, `service_owner`, who owns a service.

```bash
cd examples/agent-sdk && npm install
tracewarp record --label sdk -- npx tsx agent.ts ../demo-docs "Who owns refunds, and what does R-500 mean?"
```

## Replaying

```bash
tracewarp replay --label cc --agents-only --claude-code-tools --deny-tool Bash \
  --model claude-haiku-5-5 --judge --repeat 2
```

| Option | Why a Claude Code replay needs it |
| --- | --- |
| `--claude-code-tools [folder]` | A new model reads files the recording never opened. TraceWarp answers Claude Code's `Read`, `Grep`, `Glob` and `LS` for real, read-only, inside the folder the session worked in. The folder comes from Claude Code's own prompt ("Primary working directory"), so an Agent SDK agent with its own `cwd` works too. Paths outside it, including through symlinks, are refused. |
| `--deny-tool Bash` | Models sometimes reach for `Bash` even when the session was recorded with `--allowedTools` and could never run it. The replay gives the same permission error the real session would have. TraceWarp never runs Bash or any tool that writes. |
| `--agents-only` | Skips Claude Code's side calls. |

The same settings can live in `tracewarp.yaml`:

```yaml
builtins:
  claudeCode: { enabled: true }   # optional root: ./docs
tools:
  Bash: { deny: true }
```

Two more things happen without any option:

- **On-demand tools are offered again.** Claude Code loads MCP tools lazily. The model calls `ToolSearch`, and
  the next request carries the tool's definition. TraceWarp records those later definitions and adds each one to
  the replay once the replayed `ToolSearch` result points at it.
- **Cost is compared without the prompt cache.** A replay sends nearly the same prompt as its recording, minutes
  later, so it reads the cache the recording paid to write. On our first Claude Code replay that made an
  unchanged run look 82% cheaper ($0.147 billed vs $0.027). TraceWarp now prices every input token at the
  uncached rate for the comparison (-1% on that run) and shows the billed cost next to it.

## Results

### Claude Code over the payments docs

There were 5 on-call questions over `examples/demo-docs/`, each recorded once on Sonnet 5.5 with
`--allowedTools "Read,Grep,Glob"`.

| Replay | Runs | Unreplayable | Answer changed (judge) | Cost (no cache) |
| --- | --- | --- | --- | --- |
| No change ×2, recording only | 10 | 5 | 0 of 5 | -25% |
| No change ×2, `--claude-code-tools` | 10 | 0 | 0 of 10 | -17% |
| Haiku 5.5, `--claude-code-tools` | 5 | 0 | 0 of 5 | **-94%** |
| Opus 5.5, `--claude-code-tools` | 5 | 2 (called Bash) | 0 of 3 | +97% |
| Opus 5.5, `--claude-code-tools --deny-tool Bash` | 5 | 0 | 0 of 5 | **+138%** |

- Without the built-in tools, half the unchanged replays stopped at a read the recording never made. With them,
  none did.
- Haiku 5.5 kept every answer's substance at 6% of the cost on these questions.
- Opus 5.5 called `Bash` (`ls`, `grep -ril`) in 2 of 5 runs even though the session could not run it. With the
  call denied, as it would have been, all 5 replays finished with the same answers.
- On a sixth trace, one of two unchanged replays opened `README.md`, which the recording never read, and added
  an on-call channel to an answer that had said no contact was documented. The judge called it changed, which is
  right by the rubric. Run-to-run noise can change an answer, which is why `--repeat` exists.

### Agent SDK agent with an MCP tool

There were 3 questions that need the `service_owner` tool, each recorded once on Sonnet 5.5 and replayed twice
per setup.

| Replay | Runs | Used `service_owner` | Answer changed (judge) | Cost (no cache) |
| --- | --- | --- | --- | --- |
| No change ×2 | 6 | 6 of 6 | 0 of 6 | 0% |
| Haiku 5.5 ×2 | 6 | **0 of 6** | **6 of 6** | -95% |
| Opus 5.5 ×2 | 6 | 6 of 6 | 1 of 6 | +156% |

This is the regression TraceWarp exists to catch. Haiku 5.5 answered from the files every time and never
searched for the deferred MCP tool, so it said refunds had no documented owner, or sent people to the wrong
channel. The file-only Claude Code test above showed no regression at all, so a team checking only that would
have shipped the switch. The single Opus change is borderline: whether a runbook step "confirms" the owner.

## Bugs this found in TraceWarp

Replaying real Claude Code sessions found five problems that the plain API agent from week 2 never hit. Each now
has a test:

1. **The prompt cache faked savings.** The fix is cache-neutral cost, described above.
2. **Deferred tools were lost.** Tools that a later request added were never offered on replay, so every model
   "regressed" on MCP tools. TraceWarp now records them as `laterTools`.
3. **`tool_reference` blocks became text.** A recorded `ToolSearch` result was turned into a JSON string, which
   the API cannot load a tool from. They are now passed through.
4. **The wrong working folder.** The Agent SDK agent set its own `cwd`, so recorded absolute paths were mapped
   into a folder that did not exist. That made 3 of 6 unchanged replays look like regressions. The folder now
   comes from the session's own prompt.
5. **Noise from parallel calls.** Claude Code reads several files in one turn, and their order changes between
   runs. Calls in one turn are now compared as a set. The tool alignment also prefers identical calls, so one
   extra read no longer shifts every later read onto the wrong partner.

## Limits

- The built-in tools reimplement Claude Code's output formats. They are close, but sort order and some regex
  edge cases can differ from the real tools.
- In-process SDK MCP tools (`createSdkMcpServer`) cannot be run live by TraceWarp. A replay answers them from
  the recording, or by fuzzy match. Put the tool behind a real MCP server and mark it `readOnly` and `live` to
  answer new calls for real.
- These are small samples: 5 and 3 tasks over 7 files, with 1-2 repeats.
