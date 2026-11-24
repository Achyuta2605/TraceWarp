#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import spawn from "cross-spawn";
import { CLI_NAME, CONFIG_FILE_NAME, DEFAULT_UPSTREAM, PRODUCT_NAME, UPSTREAM_ENV_VAR } from "./brand.js";
import { startRecordingProxy } from "./capture.js";
import { ConfigError, loadConfig } from "./config.js";
import { diffTraces, summarize, type TraceDiff } from "./diff.js";
import type { Changes } from "./engine.js";
import { formatDiff, formatSummary, formatTrace, formatTraceList } from "./format.js";
import { ClaudeJudge } from "./judge.js";
import { defaultOverwatchDb, enrichFromOverwatch } from "./overwatch.js";
import { AnthropicProvider, MissingApiKeyError } from "./provider.js";
import { Recorder } from "./recorder.js";
import { type ReportInput, renderMarkdown, renderReport } from "./report.js";
import { runReplays } from "./run.js";
import { defaultDir, type Trace, TraceFormatError, TraceStore } from "./trace.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

function positiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== value.trim())
    throw new InvalidArgumentError("must be a positive whole number");
  return n;
}

function collect(value: string, all: string[]): string[] {
  return [...all, value];
}

/** Exit code for bad input or setup (no traces, no key, a bad flag or config), kept apart from "a trace changed". */
const BAD_INPUT = 3;

function fail(message: string, code = BAD_INPUT): never {
  process.stderr.write(`${CLI_NAME}: ${message}\n`);
  process.exit(code);
}

const STARTER_CONFIG = `# ${PRODUCT_NAME} replay settings. Every key is optional.
replay:
  fuzzyThreshold: 0.85   # how alike a call must be to a recorded one to reuse its result (0-1)
  onMiss: stop           # stop | continue: what to do when a call has no recorded result
  simulate: false        # let a cheap model invent results for unrecorded calls
  simulateModel: claude-haiku-5-5
  maxTurns: 50

judge:
  enabled: false         # let a Claude judge decide whether final answers changed (or pass --judge)
  model: claude-sonnet-5-5

# Real MCP servers for read-only tools, used only when a call has no recording.
servers: {}
#  fs:
#    command: [npx, -y, "@modelcontextprotocol/server-filesystem", "."]

tools: {}
#  mcp__fs__read_text_file:
#    readOnly: true
#    live: fs
`;

const program = new Command()
  .name(CLI_NAME)
  .description(`${PRODUCT_NAME}: record real agent runs, replay them with a change, and see exactly what broke.`)
  .version(version)
  .enablePositionalOptions()
  .option("-d, --dir <path>", "where traces and runs are kept", defaultDir())
  // Usage errors exit with BAD_INPUT too, so CI can tell them from a regression; help and --version exit 0.
  .exitOverride((err) => process.exit(err.exitCode === 0 ? 0 : BAD_INPUT));

function store(): TraceStore {
  return new TraceStore(resolve(program.opts<{ dir: string }>().dir));
}

program
  .command("record")
  .description("Record every Claude API call an agent makes. Starts a local proxy and runs the agent through it.")
  .usage("[options] -- <command> [args...]")
  .argument("[command]", "the agent to run; without one, the proxy runs until you stop it")
  .argument("[args...]", "arguments for the agent")
  .option("-p, --port <port>", "proxy port (default: any free port)", positiveInt)
  .option("-l, --label <label>", "a name to tag these traces with, e.g. the agent or test suite")
  .option(
    "--upstream <url>",
    `where to forward calls (default: $${UPSTREAM_ENV_VAR}, then $ANTHROPIC_BASE_URL, then ${DEFAULT_UPSTREAM})`,
  )
  .passThroughOptions()
  .addHelpText(
    "after",
    `
The agent must read ANTHROPIC_BASE_URL, as the Anthropic SDKs, the Claude Agent SDK and Claude Code do.
Examples:
  ${CLI_NAME} record -- node my-agent.js
  ${CLI_NAME} record --label support-bot -- python agent.py
  ${CLI_NAME} record --port 4320        # then set ANTHROPIC_BASE_URL=http://127.0.0.1:4320 yourself`,
  )
  .action(
    async (command: string | undefined, args: string[], o: { port?: number; label?: string; upstream?: string }) => {
      const recorder = new Recorder({
        store: store(),
        source: "proxy",
        ...(o.label ? { label: o.label } : {}),
        onTrace: (t, path) =>
          process.stderr.write(`[${CLI_NAME}] saved ${t.id} (${t.steps.length} tool calls, ${t.status}) → ${path}\n`),
      });
      const proxy = await startRecordingProxy(recorder, {
        ...(o.port ? { port: o.port } : {}),
        ...(o.upstream ? { upstream: o.upstream } : {}),
        onError: (e) => process.stderr.write(`[${CLI_NAME}] could not record a call: ${e.message}\n`),
      });
      const stop = async (code: number) => {
        await proxy.close();
        recorder.flush();
        process.stderr.write(
          `[${CLI_NAME}] ${recorder.tracesWritten} traces recorded from ${proxy.calls()} API calls\n`,
        );
        process.exit(code);
      };
      if (!command) {
        process.stderr.write(
          `[${CLI_NAME}] recording proxy on ${proxy.url}. Set ANTHROPIC_BASE_URL=${proxy.url} and run your agent. Ctrl+C to stop.\n`,
        );
        let stopping = false;
        for (const sig of ["SIGINT", "SIGTERM"] as const) {
          process.on(sig, () => {
            // A second Ctrl+C exits at once, even if a call in flight is stuck.
            if (stopping) process.exit(130);
            stopping = true;
            void stop(0);
          });
        }
        return;
      }
      const child = spawn(command, args, {
        stdio: "inherit",
        env: { ...process.env, ANTHROPIC_BASE_URL: proxy.url },
      });
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
      child.on("error", (e) => {
        process.stderr.write(`[${CLI_NAME}] could not start ${command}: ${e.message}\n`);
        void stop(127);
      });
      child.on("exit", (code, signal) => void stop(code ?? (signal ? 1 : 0)));
    },
  );

program
  .command("list")
  .alias("traces")
  .description("List recorded traces.")
  .option("--json", "print JSON")
  .action((o: { json?: boolean }) => {
    const traces = store().list((file, e) => process.stderr.write(`skipped ${file}: ${e.message}\n`));
    console.log(
      o.json
        ? JSON.stringify(
            traces.map((t) => ({ id: t.id, model: t.request.model, status: t.status, steps: t.steps.length })),
            null,
            2,
          )
        : formatTraceList(traces),
    );
  });

program
  .command("show")
  .description("Show one trace: the task, every tool call and the final answer.")
  .argument("<trace>", "trace id, unique id prefix, or file path")
  .option("--json", "print the raw trace")
  .action((ref: string, o: { json?: boolean }) => {
    const t = loadOrFail(ref);
    console.log(o.json ? JSON.stringify(t, null, 2) : formatTrace(t));
  });

function loadOrFail(ref: string): Trace {
  try {
    return store().load(ref);
  } catch (e) {
    if (e instanceof TraceFormatError) fail(e.message);
    throw e;
  }
}

function parseParam(value: string, all: Record<string, unknown>): Record<string, unknown> {
  const eq = value.indexOf("=");
  if (eq <= 0) throw new InvalidArgumentError('use key=value, e.g. max_tokens=8000 or output_config={"effort":"high"}');
  const k = value.slice(0, eq);
  const raw = value.slice(eq + 1);
  let v: unknown = raw;
  try {
    v = JSON.parse(raw);
  } catch {
    // a plain string
  }
  return { ...all, [k]: v };
}

function readFileArg(path: string, what: string): string {
  if (!existsSync(path)) fail(`${what} file not found: ${path}`);
  return readFileSync(path, "utf8");
}

program
  .command("replay")
  .description("Replay recorded traces with a change and report what behaved differently.")
  .argument("[traces...]", "trace ids or prefixes (default: --all)")
  .option("-a, --all", "replay every recorded trace")
  .option("-l, --label <label>", "only traces with this label")
  .option("-m, --model <model>", "model to replay on, e.g. claude-sonnet-5-5")
  .option("--system <file>", "replace the system prompt with this file's text")
  .option(
    "--tool-desc <name=file>",
    "replace a tool's description with a file's text (repeatable)",
    collect,
    [] as string[],
  )
  .option("--remove-tool <name>", "hide a tool from the model (repeatable)", collect, [] as string[])
  .option("--param <key=json>", "override a request setting, e.g. max_tokens=8000 (repeatable)", parseParam, {})
  .option("-c, --config <path>", `replay settings (default: ./${CONFIG_FILE_NAME})`)
  .option("-j, --concurrency <n>", "replays to run at once", positiveInt, 2)
  .option("-r, --repeat <n>", "replay each trace n times, to tell real changes from run-to-run noise", positiveInt, 1)
  .option("--judge", "let a Claude judge decide whether final answers changed")
  .option("--no-judge", "use only the key-facts check, even if the config enables the judge")
  .option("--judge-model <model>", "model for the judge (default from config: claude-sonnet-5-5)")
  .option("--write-run-dir <file>", "write the run's folder path to this file (for CI scripts)")
  .option("--include-incomplete", "with --all or --label, also replay traces that did not finish when recorded")
  .option("--fail-on-change", "exit with code 1 when a trace changed in most of its replays (for CI)")
  .option(
    "--fail-on <what>",
    "with --fail-on-change: any (tool path or answer, default) or answer (only a changed final answer)",
    (v: string) => {
      if (v !== "any" && v !== "answer") throw new InvalidArgumentError("use any or answer");
      return v;
    },
    "any",
  )
  .option("--json", "print the run summary and diffs as JSON")
  .addHelpText(
    "after",
    `
Exit codes: 0 done; 1 a trace changed (only with --fail-on-change; with --repeat, in more than half of its
replays); 2 a replay failed with an error, or every judge call failed; 3 bad input or setup.`,
  )
  .action(
    async (
      refs: string[],
      o: {
        all?: boolean;
        label?: string;
        model?: string;
        system?: string;
        toolDesc: string[];
        removeTool: string[];
        param: Record<string, unknown>;
        config?: string;
        concurrency: number;
        includeIncomplete?: boolean;
        repeat: number;
        judge?: boolean;
        judgeModel?: string;
        writeRunDir?: string;
        failOnChange?: boolean;
        failOn: "any" | "answer";
        json?: boolean;
      },
    ) => {
      const s = store();
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig(o.config);
      } catch (e) {
        if (e instanceof ConfigError) fail(e.message);
        throw e;
      }
      let baselines = refs.length
        ? refs.map(loadOrFail)
        : o.all || o.label
          ? s.list()
          : fail("name traces to replay, or pass --all");
      if (o.label) baselines = baselines.filter((t) => t.label === o.label);
      baselines = baselines.filter((t) => t.source !== "replay");
      if (!refs.length && !o.includeIncomplete) {
        const skipped = baselines.filter((t) => t.status !== "complete").length;
        if (skipped) {
          process.stderr.write(
            `[${CLI_NAME}] skipped ${skipped} traces that did not finish when recorded (--include-incomplete to replay them)\n`,
          );
        }
        baselines = baselines.filter((t) => t.status === "complete");
      }
      if (!baselines.length) fail("no traces to replay");

      const changes: Changes = {};
      if (o.model) changes.model = o.model;
      if (o.system) changes.system = readFileArg(o.system, "system prompt");
      if (o.toolDesc.length) {
        changes.toolDescriptions = {};
        for (const pair of o.toolDesc) {
          const eq = pair.indexOf("=");
          if (eq <= 0) fail(`--tool-desc expects name=file, got "${pair}"`);
          changes.toolDescriptions[pair.slice(0, eq)] = readFileArg(pair.slice(eq + 1), "tool description");
        }
      }
      if (o.removeTool.length) changes.removeTools = o.removeTool;
      if (Object.keys(o.param).length) changes.params = o.param;
      if (!Object.keys(changes).length) {
        process.stderr.write(
          `[${CLI_NAME}] no change given: replaying as recorded (useful to measure run-to-run noise)\n`,
        );
      }

      let provider: AnthropicProvider;
      try {
        provider = new AnthropicProvider();
      } catch (e) {
        if (e instanceof MissingApiKeyError) fail(e.message);
        throw e;
      }
      const judgeOn = o.judge === undefined ? config.judge.enabled || Boolean(o.judgeModel) : o.judge;
      const judge = judgeOn
        ? new ClaudeJudge(provider, {
            model: o.judgeModel ?? config.judge.model,
            cachePath: join(s.dir, "judge-cache.json"),
          })
        : undefined;
      const result = await runReplays({
        store: s,
        baselines,
        changes,
        provider,
        config,
        ...(judge ? { judge } : {}),
        concurrency: o.concurrency,
        repeat: o.repeat,
        onDone: (d, c) => {
          if (o.json) return;
          console.log(formatDiff(d));
          for (const w of c.replay?.warnings ?? []) console.log(`  note    ${w}`);
          if (c.replay?.error) console.log(`  error   ${c.replay.error}`);
          console.log("");
        },
      });
      if (o.json)
        console.log(JSON.stringify({ run: result.id, summary: result.summary, diffs: result.diffs }, null, 2));
      else {
        console.log(formatSummary(result.summary, `Run ${result.id}`));
        console.log(`  saved to ${result.dir}`);
        console.log(`  report  ${join(result.dir, "report.html")}`);
      }
      if (o.writeRunDir) writeFileSync(o.writeRunDir, `${result.dir}\n`);
      const j = result.summary.judge;
      if (judge && j.failed) {
        process.stderr.write(
          `[${CLI_NAME}] the judge failed on ${j.failed} of ${j.failed + j.judged} answers; those kept the key-facts result\n`,
        );
      }
      if (result.aborted) {
        process.stderr.write(`${CLI_NAME}: stopped early: ${result.aborted}\n`);
        process.exitCode = 2;
      } else if (result.summary.verdicts.error || (judge && j.failed && !j.judged)) process.exitCode = 2;
      else if (
        o.failOnChange &&
        (o.failOn === "answer" ? result.summary.answerChangedTraces : result.summary.changedTraces)
      ) {
        process.exitCode = 1;
      }
    },
  );

program
  .command("report")
  .description("Rebuild the HTML report and Markdown summary of a replay run (default: the latest run).")
  .argument("[run]", "run id or unique prefix, e.g. run_mwu...")
  .option("--md", "print the Markdown summary instead of the report's path")
  .action((ref: string | undefined, o: { md?: boolean }) => {
    const s = store();
    const runs = existsSync(s.runsDir) ? readdirSync(s.runsDir).filter((r) => r.startsWith("run_")) : [];
    const matches = ref ? runs.filter((r) => r.startsWith(ref)) : runs.sort().slice(-1);
    if (matches.length !== 1) fail(ref ? `${matches.length} runs match "${ref}"` : "no replay runs yet");
    const dir = join(s.runsDir, matches[0] as string);
    let input: ReportInput;
    try {
      const meta = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
      const diffs = JSON.parse(readFileSync(join(dir, "diffs.json"), "utf8")) as TraceDiff[];
      input = {
        runId: meta.id,
        createdAt: meta.createdAt,
        changes: meta.changes ?? {},
        summary: summarize(diffs),
        diffs,
      };
    } catch (e) {
      fail(`could not read run ${matches[0]}: ${(e as Error).message}`);
    }
    writeFileSync(join(dir, "report.html"), renderReport(input));
    const md = renderMarkdown(input);
    writeFileSync(join(dir, "summary.md"), md);
    console.log(o.md ? md : join(dir, "report.html"));
  });

program
  .command("diff")
  .description("Compare two traces, e.g. a recording and one of its replays.")
  .argument("<baseline>", "trace id, prefix or file")
  .argument("<candidate>", "trace id, prefix or file")
  .option("--json", "print JSON")
  .action((a: string, b: string, o: { json?: boolean }) => {
    const d = diffTraces(loadOrFail(a), loadOrFail(b));
    console.log(o.json ? JSON.stringify(d, null, 2) : formatDiff(d));
  });

program
  .command("import-overwatch")
  .description("Attach MCP server names and timings from an AgentOverwatch log to recorded tool calls.")
  .option("--db <path>", "AgentOverwatch log", defaultOverwatchDb())
  .action((o: { db: string }) => {
    const s = store();
    const traces = s.list().filter((t) => t.source !== "replay");
    let result: ReturnType<typeof enrichFromOverwatch>;
    try {
      result = enrichFromOverwatch(traces, o.db);
    } catch (e) {
      fail((e as Error).message);
    }
    for (const t of result.changed) s.save(t);
    console.log(
      `Matched ${result.matched} tool calls to AgentOverwatch (${result.unmatched} not found) across ${result.changed.length} traces.`,
    );
  });

program
  .command("init")
  .description(`Write a starter ${CONFIG_FILE_NAME} in this folder.`)
  .action(() => {
    if (existsSync(CONFIG_FILE_NAME)) fail(`${CONFIG_FILE_NAME} already exists`);
    writeFileSync(CONFIG_FILE_NAME, STARTER_CONFIG);
    console.log(`Wrote ${CONFIG_FILE_NAME}`);
  });

program.parseAsync().catch((e: Error) => fail(e.message));
