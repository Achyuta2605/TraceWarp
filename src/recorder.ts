import { canonical } from "./json.js";
import type { LaterTool } from "./trace.js";
import {
  buildTrace,
  type Exchange,
  type Message,
  type MessageParam,
  newTraceId,
  type Trace,
  TraceStore,
} from "./trace.js";

/**
 * Turns a stream of Messages API calls into traces. An agent loop resends the whole conversation on every call,
 * so a call belongs to an open trace when it answers that trace's last tool calls (or extends its messages).
 * A trace is written to disk when the model stops asking for tools.
 */

export interface RecordedCall {
  /** The JSON body sent to POST /v1/messages. */
  body: Record<string, unknown>;
  /** Request headers a replay needs (anthropic-beta, anthropic-version). Never credentials. */
  headers?: Record<string, string>;
  response: Message;
  startedAt: number;
  latencyMs: number;
}

interface OpenTrace {
  id: string;
  createdAt: number;
  request: Trace["request"];
  headers: Record<string, string>;
  /** Tool definitions a later call added (tools loaded on demand), with the turn they first appeared in. */
  laterTools: LaterTool[];
  /** Model and system text: a call only joins a trace by message prefix when these match. */
  fingerprint: string;
  /** Tool names of the last call. A later call may add tools (loaded on demand) but not drop them. */
  tools: Set<string>;
  exchanges: Exchange[];
  /** The conversation as the next call should resend it: last request messages plus the reply. */
  expected: MessageParam[];
  pendingToolIds: Set<string>;
}

export interface RecorderOptions {
  store?: TraceStore;
  source: Trace["source"];
  label?: string;
  /** Working folder of the agent, saved on each trace so a replay can run read-only file tools there. */
  cwd?: string;
  /** Called after each trace is written. */
  onTrace?: (trace: Trace, path: string) => void;
  /** Traces left open longer than this many calls are closed as incomplete. */
  maxOpen?: number;
}

const CONTINUE_REASONS = new Set(["tool_use", "pause_turn"]);

export class Recorder {
  readonly store: TraceStore;
  private open: OpenTrace[] = [];
  private written = 0;

  constructor(private readonly opts: RecorderOptions) {
    this.store = opts.store ?? new TraceStore();
  }

  get tracesWritten(): number {
    return this.written;
  }

  get openTraces(): number {
    return this.open.length;
  }

  record(call: RecordedCall): void {
    const messages = Array.isArray(call.body.messages) ? (call.body.messages as MessageParam[]) : [];
    const fingerprint = fingerprintOf(call.body);
    const match = this.findOpen(messages, fingerprint, toolNames(call.body));
    let t: OpenTrace;
    let appended: MessageParam[];
    if (match) {
      t = match;
      appended = appendedSince(messages, t.expected.length);
    } else {
      const { stream: _stream, messages: _messages, ...rest } = redact(call.body);
      t = {
        id: newTraceId(),
        createdAt: call.startedAt,
        request: { ...rest, model: String(call.body.model ?? "unknown"), messages },
        headers: { ...(call.headers ?? {}) },
        fingerprint,
        tools: toolNames(call.body),
        laterTools: [],
        exchanges: [],
        expected: [],
        pendingToolIds: new Set(),
      };
      this.open.push(t);
      appended = [];
      if (this.open.length > (this.opts.maxOpen ?? 200)) this.finish(this.open[0] as OpenTrace, "incomplete");
    }
    if (match) noteLaterTools(t, call.body);
    t.exchanges.push({ startedAt: call.startedAt, latencyMs: call.latencyMs, appended, response: call.response });
    t.expected = [...messages, { role: "assistant", content: call.response.content as MessageParam["content"] }];
    t.tools = toolNames(call.body);
    t.pendingToolIds = new Set(call.response.content.filter((b) => b.type === "tool_use").map((b) => b.id));
    if (!CONTINUE_REASONS.has(call.response.stop_reason ?? "")) this.finish(t, "complete");
  }

  /** Writes every open trace as incomplete. Call when the agent has exited. */
  flush(): void {
    for (const t of [...this.open]) this.finish(t, "incomplete");
  }

  private findOpen(messages: MessageParam[], fingerprint: string, tools: Set<string>): OpenTrace | undefined {
    const answered = new Set<string>();
    for (const m of messages) {
      if (m.role === "user" && typeof m.content !== "string") {
        for (const b of m.content) if (b.type === "tool_result") answered.add(b.tool_use_id);
      }
    }
    // Tool-use ids are unique, so a call that answers them is the same task even if the client rewrote history.
    for (let i = this.open.length - 1; i >= 0; i--) {
      const t = this.open[i] as OpenTrace;
      if ([...t.pendingToolIds].some((id) => answered.has(id))) return t;
    }
    let best: OpenTrace | undefined;
    for (const t of this.open) {
      if (t.fingerprint !== fingerprint || [...t.tools].some((n) => !tools.has(n))) continue;
      if (messages.length > t.expected.length && isPrefix(t.expected, messages)) {
        if (!best || t.expected.length > best.expected.length) best = t;
      }
    }
    return best;
  }

  private finish(t: OpenTrace, status: Trace["status"]): void {
    this.open = this.open.filter((o) => o !== t);
    const cwd = clientCwd(t.request) ?? this.opts.cwd;
    const trace = buildTrace({
      id: t.id,
      createdAt: t.createdAt,
      source: this.opts.source,
      ...(this.opts.label ? { label: this.opts.label } : {}),
      ...(cwd ? { cwd } : {}),
      status,
      request: t.request,
      ...(Object.keys(t.headers).length ? { headers: t.headers } : {}),
      ...(t.laterTools.length ? { laterTools: t.laterTools } : {}),
      exchanges: t.exchanges,
    });
    const path = this.store.save(trace);
    this.written++;
    this.opts.onTrace?.(trace, path);
  }
}

/**
 * What makes two calls part of the same agent: model and system text (cache markers ignored). With the tool list
 * (see findOpen), it keeps two agents or sub-agents that start with the same user message in separate traces.
 */
function fingerprintOf(body: Record<string, unknown>): string {
  const s = body.system;
  const system = Array.isArray(s) ? s.map((b) => String((b as { text?: unknown }).text ?? "")).join("\n") : (s ?? "");
  return canonical({ model: body.model ?? null, system });
}

function toolNames(body: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(body.tools) ? (body.tools as { name?: unknown }[]).map((t) => String(t.name)) : []);
}

/** Never write credentials into a trace: MCP connector tokens are replaced, keeping the field so it shows. */
/**
 * The folder a Claude Code or Agent SDK session worked in, which its prompt names. It can differ from the folder
 * `tracewarp record` ran in (an Agent SDK agent sets its own cwd).
 */
export function clientCwd(request: Trace["request"]): string | undefined {
  const m = /Primary working directory: ([^\n"\\]+)/.exec(JSON.stringify([request.system, request.messages]));
  const dir = m?.[1]?.trim();
  return dir?.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir ?? "") ? dir : undefined;
}

/** Saves the definitions of tools this call has that the trace's first request did not. */
function noteLaterTools(t: OpenTrace, body: Record<string, unknown>): void {
  if (!Array.isArray(body.tools)) return;
  const known = new Set([
    ...(Array.isArray(t.request.tools) ? (t.request.tools as { name?: unknown }[]).map((x) => String(x.name)) : []),
    ...t.laterTools.map((x) => String((x.tool as { name?: unknown }).name)),
  ]);
  for (const tool of body.tools as { name?: unknown }[]) {
    if (tool && typeof tool === "object" && !known.has(String(tool.name))) {
      t.laterTools.push({ turn: t.exchanges.length, tool });
    }
  }
}

function redact(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.mcp_servers)) return body;
  return {
    ...body,
    mcp_servers: (body.mcp_servers as Record<string, unknown>[]).map((s) =>
      s && typeof s === "object" && "authorization_token" in s ? { ...s, authorization_token: "[redacted]" } : s,
    ),
  };
}

/** Messages after the last assistant turn, or after `known` messages when there is none. */
function appendedSince(messages: MessageParam[], known: number): MessageParam[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages.slice(i + 1);
  }
  return messages.slice(Math.min(known, messages.length));
}

function isPrefix(prefix: MessageParam[], messages: MessageParam[]): boolean {
  return prefix.every((m, i) => normalize(m) === normalize(messages[i] as MessageParam));
}

/**
 * Comparable form of a message. Clients often drop fields the API added (citations: null, caller) or strip
 * thinking blocks when they resend history, so only the fields that carry meaning are compared.
 */
function normalize(m: MessageParam): string {
  const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
  const kept: unknown[] = [];
  for (const raw of blocks as unknown as Record<string, unknown>[]) {
    switch (raw.type) {
      case "thinking":
      case "redacted_thinking":
        break;
      case "text":
        kept.push({ type: "text", text: raw.text });
        break;
      case "tool_use":
        kept.push({ type: "tool_use", id: raw.id, name: raw.name, input: raw.input });
        break;
      case "tool_result":
        kept.push({
          type: "tool_result",
          tool_use_id: raw.tool_use_id,
          content: typeof raw.content === "string" ? [{ type: "text", text: raw.content }] : raw.content,
          is_error: raw.is_error === true,
        });
        break;
      default: {
        const { cache_control: _c, citations: _ci, ...rest } = raw;
        kept.push(rest);
      }
    }
  }
  return canonical({ role: m.role, content: kept });
}
