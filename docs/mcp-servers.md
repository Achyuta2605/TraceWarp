# Replaying agents that use MCP servers

*Real API runs, November 26, 2026, Claude Code 2.1.332, `@modelcontextprotocol/server-filesystem` 2.4.0 and
`mcp-server-git` 2026.11.18.*

When you replay an agent with a new model, it reads things the recording never read. With MCP tools, every one
of those calls used to stop the replay as unreplayable unless you listed the server's read-only tools by hand.
Presets do that for three common servers.

```yaml
# tracewarp.yaml
servers:
  fs:  { preset: filesystem, root: ./payments }
  git: { preset: git, root: ./payments }
```

```bash
tracewarp replay --label mcp --agents-only --model claude-haiku-5-5 --judge --repeat 2
```

## What a preset does

- **It starts a pinned server, confined to `root`.** That is the filesystem server with `root` as its only allowed
  folder, or the git server with `--repository <root>`. Set `command` to run your own install instead.
- **It makes only the read-only tools live.** The table in the [README](../README.md#mcp-server-presets) lists
  them. Writes (`write_file`, `edit_file`, `git_commit`, `git_reset`, ...) are left out, so an unrecorded write is
  unreplayable, the same as before. TraceWarp never runs them.
- **It keeps `fetch` on recorded answers.** A live fetch would see today's web page, and it would let a replayed
  model reach any URL from your CI machine. `openWorld: true` turns it on.
- **Your own `tools` entries win.** For example, `mcp__fs__read_media_file: { deny: true }`.

The tool lists come from each server's own tool list. We checked them by hand instead of trusting the servers'
`readOnlyHint` annotations, because a hint is only the server's claim. We also checked each pinned version
against escapes:

| Attempt | Result |
| --- | --- |
| `read_text_file /etc/passwd`, `../../package.json` | refused: outside allowed directories |
| a symlink inside the root pointing at `/etc/passwd` | refused: symlink target outside allowed directories |
| `git_status` on a repository outside `--repository`, or `root/../other` | refused |
| `git_diff target=--output=/tmp/x`, `git_show revision=--output=...`, `git_branch contains=--output=...` | refused: cannot start with `-`, and no file written |

Older `mcp-server-git` releases let `--output=` through, which writes files. That is why presets pin a version.

## The test

The agent was Claude Code on Sonnet 5.5 with two MCP servers and no built-in tools:

```bash
claude -p "<question>" --mcp-config mcp.json --strict-mcp-config --tools "" --allowedTools "mcp__fs__*" "mcp__git__*"
```

It ran over a small git repository: the payments docs from `examples/demo-docs`, plus three commits by two authors
and one uncommitted change. There were 5 questions that need both files and history, such as "How many times do
we retry gateway calls now, and who changed it, when, and why?" and "Is there anything changed in the repo that
hasn't been committed yet?". Each was recorded once, then replayed twice per setup, and the Claude judge
(Sonnet 5.5) ruled on every final answer.

## Results

| Replay | Runs | Unreplayable | Answer changed (judge) | Cost (no cache) |
| --- | --- | --- | --- | --- |
| No change, recording only (no presets) | 10 | **8** | 0 of 2 | 0% |
| No change, presets | 10 | **0** | 0 of 10 | -9% |
| Haiku 5.5, presets | 10 | 0 | 0 of 10 | **-95%** |
| Opus 5.5, presets | 10 | 0 | 0 of 10 | **+113%** |

- **Without presets, 8 of 10 unchanged replays stopped.** A replay of the very same model searched for
  `**/*polic*` where the recording searched for `**/*policy*`, or asked `git_log` for 20 commits instead of 30.
  With presets, 10 to 17 calls per setup were answered live, and every replay finished.
- **On these tasks, Haiku 5.5 kept every answer at 5% of the cost.** It read the same commits and files, often in
  another order. Opus 5.5 also kept every answer, at about twice the cost.
- **Tool paths are noisy, and answers are not.** Even unchanged replays changed tool path or arguments in 7 of
  10 runs: another `max_count`, a reworded glob, `excludePatterns` in another order, short commit hashes instead
  of long ones. That is why TraceWarp rules on the answer (key facts, or the judge) and doesn't count a different
  path as a regression.
- **A recorded call is answered from the recording, even when the repository has moved on.** We committed the
  uncommitted change and replayed "Is there anything uncommitted?" again. The replay made the same 3 calls, got
  the 3 recorded answers, and came out the same. Only calls the recording lacks see the repository as it is now.

Unlike the [Agent SDK test](claude-code.md#agent-sdk-agent-with-an-mcp-tool), this one found no regression:
Haiku held up when the tools were in plain view and the answers sat in files and commits. These runs measure how
well the presets keep replays going, not which model to ship. Run your own traffic before you switch.

## Limits

- 5 tasks, 1 repository, 2 replays per setup.
- The `fetch` preset was not tested live here, because this test machine's network proxy blocks the fetch
  server's outbound requests. Its default is to answer from recordings only.
- The git preset needs `uv` (`uvx`) and the filesystem preset needs `npx`, unless you set `command`.
- Presets assume the server is named the way your agent names it (`fs` gives `mcp__fs__*`). Use `toolPrefix`
  for other naming.
