import Anthropic from "@anthropic-ai/sdk";
import { API_KEY_ENV_VAR, DEFAULT_UPSTREAM, UPSTREAM_ENV_VAR } from "./brand.js";
import type { Message } from "./trace.js";

/** Something that answers Messages API requests. Replays use the real API; tests use a script. */
export interface Provider {
  create(body: Record<string, unknown>): Promise<Message>;
}

export function apiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[API_KEY_ENV_VAR] || env.ANTHROPIC_API_KEY || undefined;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(`replays call the Claude API: set ${API_KEY_ENV_VAR} (or ANTHROPIC_API_KEY)`);
  }
}

export class AnthropicProvider implements Provider {
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string; baseURL?: string; maxRetries?: number } = {}) {
    const apiKey = opts.apiKey ?? apiKeyFromEnv();
    if (!apiKey) throw new MissingApiKeyError();
    this.client = new Anthropic({
      apiKey,
      // Explicit, so a proxy URL left in ANTHROPIC_BASE_URL (for example TraceWarp's own) is never used by accident.
      baseURL: opts.baseURL ?? process.env[UPSTREAM_ENV_VAR] ?? DEFAULT_UPSTREAM,
      maxRetries: opts.maxRetries ?? 4,
    });
  }

  async create(body: Record<string, unknown>): Promise<Message> {
    const { stream: _stream, ...params } = body;
    // Streaming keeps long agent turns clear of HTTP timeouts.
    return this.client.messages.stream(params as unknown as Anthropic.MessageStreamParams).finalMessage();
  }
}

/**
 * A provider that plays back scripted replies, for tests and dry runs. Each entry is a function of the request,
 * or a fixed reply. Throws when the script runs out.
 */
export class ScriptedProvider implements Provider {
  readonly requests: Record<string, unknown>[] = [];
  private i = 0;

  constructor(
    private readonly script: Array<Partial<Message> | ((body: Record<string, unknown>) => Partial<Message>)>,
  ) {}

  async create(body: Record<string, unknown>): Promise<Message> {
    this.requests.push(structuredClone(body));
    const next = this.script[this.i++];
    if (!next) throw new Error("ScriptedProvider: script exhausted");
    const reply = typeof next === "function" ? next(body) : next;
    return fakeMessage({ model: String(body.model), ...reply });
  }
}

let fakeId = 0;

/** A complete Message with sensible defaults, for tests and fixtures. */
export function fakeMessage(m: Partial<Message> & { model?: string }): Message {
  const content = m.content ?? [];
  const hasTool = content.some((b) => b.type === "tool_use");
  return {
    id: `msg_fake_${++fakeId}`,
    type: "message",
    role: "assistant",
    model: m.model ?? "claude-sonnet-5-5",
    content,
    stop_reason: m.stop_reason ?? (hasTool ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...(m.usage ?? {}),
    },
    ...Object.fromEntries(Object.entries(m).filter(([k]) => !["content", "usage", "stop_reason", "model"].includes(k))),
  } as Message;
}
