import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { DIR_ENV_VAR, HOME_DIR_NAME } from "./brand.js";
import { costUsd, type TokenUsage } from "./pricing.js";

/**
 * A trace is one agent task: it starts at a user message, runs through every model turn and tool call, and ends
 * when the model stops asking for tools. The recorded request and responses are kept verbatim so the task can be
 * replayed; `steps` is derived from them for matching and diffing.
 */

export const TRACE_VERSION = 1;

export type MessageParam = Anthropic.MessageParam;
export type Message = Anthropic.Message;

export interface Exchange {
  /** Unix ms when the request was sent. */
  startedAt: number;
  latencyMs: number;
  /** Messages the client added since the previous exchange (tool results, mostly). Empty for the first one. */
  appended: MessageParam[];
  response: Message;
}

export type ReplayTier = "exact" | "fuzzy" | "live" | "simulated" | "unreplayable";

export interface ReplayInfo {
  tier: ReplayTier;
  /** Index into the baseline's steps of the recorded call that answered this one. */
  matchedStep?: number;
  similarity?: number;
  /** True when the matched recorded call had already answered an earlier call in this replay. */
  reused?: boolean;
  note?: string;
}

export interface ToolStep {
  /** Model turn (0-based) that asked for this call. */
  turn: number;
  toolUseId: string;
  name: string;
  input: unknown;
  /** Content of the tool_result block the agent sent back, or null when the trace ended before it did. */
  result: unknown;
  isError: boolean;
  /** MCP server that handled the call, when known (from an AgentOverwatch log). */
  server?: string;
  mcpLatencyMs?: number;
  /** How a replay answered this call. Only set on replayed traces. */
  replay?: ReplayInfo;
}

export type TraceStatus = "complete" | "incomplete" | "unreplayable" | "max_turns" | "error";

export interface ReplayMeta {
  baselineId: string;
  /** Changes applied for this replay, in a form people can read. */
  changes: Record<string, unknown>;
  warnings: string[];
  error?: string;
  /** HTTP status of the API error that ended the replay, when there was one. */
  errorStatus?: number;
}

export interface Trace {
  version: typeof TRACE_VERSION;
  id: string;
  createdAt: number;
  source: "proxy" | "sdk" | "replay" | "import";
  label?: string;
  status: TraceStatus;
  /** The first request of the task, minus `stream`. Its messages are where a replay starts. */
  request: Record<string, unknown> & { model: string; messages: MessageParam[] };
  /** Request headers a replay must resend, such as anthropic-beta. */
  headers?: Record<string, string>;
  exchanges: Exchange[];
  steps: ToolStep[];
  final: { text: string; stopReason: string | null; turns: number };
  usage: TokenUsage & { costUsd: number | null; latencyMs: number };
  replay?: ReplayMeta;
}

/** Trace ids become file names, so only these characters are allowed. */
export const TRACE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const traceSchema = z.looseObject({
  version: z.literal(TRACE_VERSION),
  id: z.string().regex(TRACE_ID_PATTERN, "must contain only letters, digits, _ and -"),
  createdAt: z.number(),
  source: z.enum(["proxy", "sdk", "replay", "import"]),
  status: z.enum(["complete", "incomplete", "unreplayable", "max_turns", "error"]),
  request: z.looseObject({ model: z.string(), messages: z.array(z.unknown()) }),
  exchanges: z.array(z.looseObject({ response: z.looseObject({ content: z.array(z.unknown()) }) })),
  steps: z.array(z.looseObject({ name: z.string(), toolUseId: z.string() })),
});

export function newTraceId(prefix = "tw"): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

/** The text of a response's text blocks, joined. */
export function responseText(m: Pick<Message, "content">): string {
  return m.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function toolResults(messages: MessageParam[]): Map<string, { content: unknown; isError: boolean }> {
  const out = new Map<string, { content: unknown; isError: boolean }>();
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") out.set(b.tool_use_id, { content: b.content ?? "", isError: b.is_error === true });
    }
  }
  return out;
}

/** Tool calls in order, each paired with the result the agent sent back in the following exchange. */
export function deriveSteps(exchanges: Exchange[]): ToolStep[] {
  const steps: ToolStep[] = [];
  exchanges.forEach((ex, turn) => {
    const results = toolResults(exchanges[turn + 1]?.appended ?? []);
    for (const b of ex.response.content) {
      if (b.type !== "tool_use") continue;
      const r = results.get(b.id);
      steps.push({
        turn,
        toolUseId: b.id,
        name: b.name,
        input: b.input,
        result: r ? r.content : null,
        isError: r?.isError ?? false,
      });
    }
  });
  return steps;
}

export function sumUsage(model: string, exchanges: Exchange[]): Trace["usage"] {
  const u: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let latencyMs = 0;
  let cost: number | null = 0;
  for (const ex of exchanges) {
    const r = ex.response.usage;
    const one: TokenUsage = {
      inputTokens: r?.input_tokens ?? 0,
      outputTokens: r?.output_tokens ?? 0,
      cacheReadTokens: r?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: r?.cache_creation_input_tokens ?? 0,
    };
    u.inputTokens += one.inputTokens;
    u.outputTokens += one.outputTokens;
    u.cacheReadTokens += one.cacheReadTokens;
    u.cacheWriteTokens += one.cacheWriteTokens;
    latencyMs += ex.latencyMs;
    // Price by the model that answered, which can differ from the one asked for (server-side fallbacks).
    const c = costUsd(ex.response.model || model, one);
    cost = cost === null || c === null ? null : cost + c;
  }
  return { ...u, costUsd: cost, latencyMs };
}

/** Builds a trace from its exchanges. Steps, final answer and usage are always recomputed. */
export function buildTrace(t: Omit<Trace, "version" | "steps" | "final" | "usage"> & { steps?: ToolStep[] }): Trace {
  const last = t.exchanges.at(-1)?.response;
  const derived = deriveSteps(t.exchanges);
  // Keep metadata (server, replay tier) that was attached to steps earlier.
  const steps = derived.map((s) => {
    const prev = t.steps?.find((p) => p.toolUseId === s.toolUseId);
    return prev ? { ...prev, ...s, result: s.result ?? prev.result, isError: s.result ? s.isError : prev.isError } : s;
  });
  return {
    version: TRACE_VERSION,
    ...t,
    steps,
    final: { text: last ? responseText(last) : "", stopReason: last?.stop_reason ?? null, turns: t.exchanges.length },
    usage: sumUsage(t.request.model, t.exchanges),
  };
}

export class TraceFormatError extends Error {}

export function parseTrace(text: string, origin = "trace"): Trace {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new TraceFormatError(`${origin} is not valid JSON: ${(e as Error).message}`);
  }
  const result = traceSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new TraceFormatError(
      `${origin} is not a TraceWarp trace: ${issue?.path.join(".") || "root"} ${issue?.message}`,
    );
  }
  return raw as Trace;
}

export function defaultDir(): string {
  return resolve(process.env[DIR_ENV_VAR] || HOME_DIR_NAME);
}

/** Traces as JSON files: `<dir>/traces/<id>.json`. Replay runs live next to them in `<dir>/runs/`. */
export class TraceStore {
  readonly tracesDir: string;
  readonly runsDir: string;

  constructor(readonly dir: string = defaultDir()) {
    this.tracesDir = join(dir, "traces");
    this.runsDir = join(dir, "runs");
  }

  save(trace: Trace, dir: string = this.tracesDir): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${trace.id}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(trace, null, 2)}\n`);
    renameSync(tmp, path);
    return path;
  }

  /** Loads a trace by id, unique id prefix, or file path. */
  load(ref: string): Trace {
    if (ref.endsWith(".json") && existsSync(ref)) return parseTrace(readFileSync(ref, "utf8"), ref);
    const ids = this.ids();
    const exact = ids.find((id) => id === ref);
    const matches = exact ? [exact] : ids.filter((id) => id.startsWith(ref));
    if (matches.length === 0) {
      const replayed = this.findReplay(ref);
      if (replayed) return parseTrace(readFileSync(replayed, "utf8"), replayed);
      throw new TraceFormatError(`no trace "${ref}" in ${this.tracesDir}`);
    }
    if (matches.length > 1) throw new TraceFormatError(`"${ref}" matches ${matches.length} traces; use more of the id`);
    const path = join(this.tracesDir, `${matches[0]}.json`);
    return parseTrace(readFileSync(path, "utf8"), path);
  }

  /** A replayed trace (rp_...) saved under runs/<run>/candidates, by id or unique prefix. */
  private findReplay(ref: string): string | undefined {
    if (!TRACE_ID_PATTERN.test(ref) || !existsSync(this.runsDir)) return undefined;
    const found: string[] = [];
    for (const run of readdirSync(this.runsDir)) {
      const dir = join(this.runsDir, run, "candidates");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -5);
        if (id === ref) return join(dir, f);
        if (id.startsWith(ref)) found.push(join(dir, f));
      }
    }
    if (found.length > 1) throw new TraceFormatError(`"${ref}" matches ${found.length} replays; use more of the id`);
    return found[0];
  }

  ids(): string[] {
    if (!existsSync(this.tracesDir)) return [];
    return readdirSync(this.tracesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  }

  /** All traces, oldest first. Files that fail to parse are skipped and reported. */
  list(onError?: (file: string, e: Error) => void): Trace[] {
    const out: Trace[] = [];
    for (const id of this.ids()) {
      const path = join(this.tracesDir, `${id}.json`);
      try {
        out.push(parseTrace(readFileSync(path, "utf8"), path));
      } catch (e) {
        onError?.(path, e as Error);
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
}
