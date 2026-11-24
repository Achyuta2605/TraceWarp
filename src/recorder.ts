import { canonical } from "./json.js";
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
  response: Message;
  startedAt: number;
  latencyMs: number;
}

interface OpenTrace {
  id: string;
  createdAt: number;
  request: Trace["request"];
  exchanges: Exchange[];
  /** The conversation as the next call should resend it: last request messages plus the reply. */
  expected: MessageParam[];
  pendingToolIds: Set<string>;
}

export interface RecorderOptions {
  store?: TraceStore;
  source: Trace["source"];
  label?: string;
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
    const match = this.findOpen(messages);
    let t: OpenTrace;
    let appended: MessageParam[];
    if (match) {
      t = match;
      appended = appendedSince(messages, t.expected.length);
    } else {
      const { stream: _stream, messages: _messages, ...rest } = call.body;
      t = {
        id: newTraceId(),
        createdAt: call.startedAt,
        request: { ...rest, model: String(call.body.model ?? "unknown"), messages },
        exchanges: [],
        expected: [],
        pendingToolIds: new Set(),
      };
      this.open.push(t);
      appended = [];
      if (this.open.length > (this.opts.maxOpen ?? 200)) this.finish(this.open[0] as OpenTrace, "incomplete");
    }
    t.exchanges.push({ startedAt: call.startedAt, latencyMs: call.latencyMs, appended, response: call.response });
    t.expected = [...messages, { role: "assistant", content: call.response.content as MessageParam["content"] }];
    t.pendingToolIds = new Set(call.response.content.filter((b) => b.type === "tool_use").map((b) => b.id));
    if (!CONTINUE_REASONS.has(call.response.stop_reason ?? "")) this.finish(t, "complete");
  }

  /** Writes every open trace as incomplete. Call when the agent has exited. */
  flush(): void {
    for (const t of [...this.open]) this.finish(t, "incomplete");
  }

  private findOpen(messages: MessageParam[]): OpenTrace | undefined {
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
      if (messages.length > t.expected.length && isPrefix(t.expected, messages)) {
        if (!best || t.expected.length > best.expected.length) best = t;
      }
    }
    return best;
  }

  private finish(t: OpenTrace, status: Trace["status"]): void {
    this.open = this.open.filter((o) => o !== t);
    const trace = buildTrace({
      id: t.id,
      createdAt: t.createdAt,
      source: this.opts.source,
      ...(this.opts.label ? { label: this.opts.label } : {}),
      status,
      request: t.request,
      exchanges: t.exchanges,
    });
    const path = this.store.save(trace);
    this.written++;
    this.opts.onTrace?.(trace, path);
  }
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
