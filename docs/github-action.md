# Gate a pull request on replayed agent runs

TraceWarp ships a GitHub Action. On every pull request that touches your agent's prompt or settings, it replays
your recorded traces with the change and fails the check when the agent starts behaving differently. The job
summary shows what changed, and the full HTML report is attached as an artifact.

```yaml
# .github/workflows/agent-regression.yml
name: Agent regression
on:
  pull_request:
    paths: ["prompts/**", "agent.config.json"]

jobs:
  replay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Achyuta2605/TraceWarp@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # One argument per line, so values with spaces or quotes arrive exactly as written.
          args: |
            --system
            prompts/support-agent.txt
            --judge
          repeat: 2
```

| Input | Default | What it does |
| --- | --- | --- |
| `anthropic-api-key` | (required) | Key for the replays. Keep it in a repository secret. |
| `args` | `""` | Any `tracewarp replay` flags, one per line: `--model`, `--system`, `--tool-desc`, `--param`, `--judge`, `-c`. |
| `dir` | `.tracewarp` | Where the recorded traces are. |
| `repeat` | `1` | Replays per trace. With 2 or more, a trace only fails the check when it changed in most of them. |
| `fail-on-change` | `true` | Fail the step on a changed trace. A replay error always fails it. |
| `artifact-name` | `tracewarp-report` | Name of the uploaded report. Make it unique when the job runs in a matrix. |
| `fail-on` | `any` | `any`: a changed tool path or answer fails. `answer`: only a changed final answer fails, which suits a model migration, where a new model often takes a different but harmless path. |

Where the traces come from: record them once with `tracewarp record`, check that they hold nothing private, and
commit `.tracewarp/traces/` (TraceWarp's default `.gitignore` advice keeps `.tracewarp` out of git, so add an exception such as `!.tracewarp/traces/`). Or keep them in a private artifact store and restore them before this step.

The step fails with exit code 1 when a trace changed, 2 when a replay (or every judge call) failed, and 3 for bad
input or setup, such as no traces or no API key (a pull request from a fork gets no secrets). Each code prints its
own error line, so a broken setup never reads as an agent regression.

The action sets up Node 22 for its own use. That also becomes the Node version for any steps that come after it in
the same job.

The uploaded report holds the full recorded tool results and answers, so treat the artifact like the traces
themselves. Its visibility follows the repository's.

Cost: a replay costs about what the recorded runs cost on the new setup. The summary prints both numbers. With `--judge`, add one Claude Sonnet 5.5 call per compared run,
also printed in the summary.
