import { type Config, defaultConfig } from "./config.js";
import { LiveTools } from "./live.js";
import type { Provider } from "./provider.js";
import { Resolver, type ToolAnswer } from "./resolver.js";
import { buildTrace, type Exchange, type MessageParam, newTraceId, type ReplayInfo, type Trace } from "./trace.js";

/**
 * Replays a recorded task with something changed (model, system prompt, tool descriptions, request settings).
 * The candidate model runs its own agent loop from the recorded starting messages; every tool call it makes is
 * answered from the recording (see Resolver), so nothing real is touched unless a tool is configured as live.
 */

export interface Changes {
  model?: string;
  /** Replaces the system prompt. */
  system?: string;
  /** Replaces tool descriptions, by tool name. */
  toolDescriptions?: Record<string, string>;
  /** Hides tools from the model, by name. */
  removeTools?: string[];
  /** Merged over the recorded request settings, e.g. { max_tokens: 8000, output_config: { effort: "high" } }. */
  params?: Record<string, unknown>;
}

export interface ReplayOptions {
  provider: Provider;
  config?: Config;
  /** Used for simulated tool results. Defaults to `provider`. */
  simulator?: Provider;
  /** Shared live MCP connections. One is created (and closed) per replay when not given. */
  live?: LiveTools;
}

/** Models that reject settings older models accepted. A replay onto them drops or rewrites those settings. */
function quirks(model: string): { noSampling: boolean; noDisabledThinking: boolean; noForcedTool: boolean } {
  const m = model.replace(/^anthropic\./, "");
  const gen5 = /^claude-(opus-5|sonnet-5-5|fable|mythos|haiku-5)/.test(m);
  return {
    noSampling: gen5 || /^claude-(opus-4-[78]|sonnet-5)/.test(m),
    noDisabledThinking: /^claude-(opus-5-5|sonnet-5-5|fable|mythos)/.test(m),
    noForcedTool: /^claude-(opus-5-5|sonnet-5-5|fable-5-[12]|mythos-5-[12])/.test(m),
  };
}

/** The first request of the replay: the recorded one with the changes applied. */
export function candidateRequest(
  recorded: Trace["request"],
  changes: Changes,
): { body: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  const { messages: _messages, ...rest } = structuredClone(recorded);
  const body: Record<string, unknown> = { ...rest, ...(changes.params ?? {}) };
  if (changes.model) body.model = changes.model;
  if (changes.system !== undefined) body.system = changes.system;
  if (Array.isArray(body.tools)) {
    const known = new Set((body.tools as { name?: string }[]).map((t) => t.name));
    for (const name of [...Object.keys(changes.toolDescriptions ?? {}), ...(changes.removeTools ?? [])]) {
      if (!known.has(name)) warnings.push(`no tool named "${name}" in the recorded request`);
    }
    body.tools = (body.tools as Record<string, unknown>[])
      .filter((t) => !changes.removeTools?.includes(String(t.name)))
      .map((t) => {
        const d = changes.toolDescriptions?.[String(t.name)];
        return d === undefined ? t : { ...t, description: d };
      });
  } else if (changes.toolDescriptions || changes.removeTools) {
    warnings.push("the recorded request has no tools to change");
  }

  const model = String(body.model);
  if (model !== recorded.model) {
    const q = quirks(model);
    if (q.noSampling) {
      for (const k of ["temperature", "top_p", "top_k"]) {
        if (k in body && !(changes.params && k in changes.params)) {
          delete body[k];
          warnings.push(`dropped ${k}: ${model} does not accept sampling settings`);
        }
      }
    }
    const thinking = body.thinking as { type?: string } | undefined;
    if (q.noDisabledThinking && thinking && (thinking.type === "disabled" || thinking.type === "enabled")) {
      if (!changes.params || !("thinking" in changes.params)) {
        delete body.thinking;
        warnings.push(`dropped thinking: ${thinking.type}: ${model} only runs adaptive thinking`);
      }
    }
    const choice = body.tool_choice as { type?: string } | undefined;
    if (q.noForcedTool && (choice?.type === "any" || choice?.type === "tool")) {
      body.tool_choice = { ...choice, type: "auto" };
      delete (body.tool_choice as { name?: string }).name;
      warnings.push(`tool_choice ${choice.type} changed to auto: ${model} does not allow forced tool use`);
    }
  }
  delete body.stream;
  return { body, warnings };
}

/** Shapes a recorded or live tool result into tool_result content the API accepts. */
function toResultContent(content: unknown): string | Record<string, unknown>[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const blocks = content.filter(
      (b) =>
        b &&
        typeof b === "object" &&
        ["text", "image", "document", "search_result"].includes((b as { type?: string }).type ?? ""),
    ) as Record<string, unknown>[];
    if (blocks.length === content.length) return blocks;
    return JSON.stringify(content);
  }
  return content === null || content === undefined ? "" : JSON.stringify(content);
}

export async function replay(baseline: Trace, changes: Changes, opts: ReplayOptions): Promise<Trace> {
  const config = opts.config ?? defaultConfig();
  const { body: base, warnings } = candidateRequest(baseline.request, changes);
  const ownLive = !opts.live && Object.keys(config.servers).length > 0;
  const live = opts.live ?? (ownLive ? new LiveTools(config.servers) : undefined);
  const resolver = new Resolver(baseline.steps, {
    config,
    tools: base.tools as unknown[] | undefined,
    ...(live ? { live } : {}),
    simulator: opts.simulator ?? opts.provider,
  });

  const messages: MessageParam[] = structuredClone(baseline.request.messages);
  const exchanges: Exchange[] = [];
  const answers = new Map<string, ToolAnswer>();
  let appended: MessageParam[] = [];
  let status: Trace["status"] = "max_turns";
  let error: string | undefined;

  try {
    for (let turn = 0; turn < config.replay.maxTurns; turn++) {
      const startedAt = Date.now();
      let response: Exchange["response"];
      try {
        response = await opts.provider.create({ ...base, messages });
      } catch (e) {
        status = "error";
        error = (e as Error).message;
        break;
      }
      exchanges.push({ startedAt, latencyMs: Date.now() - startedAt, appended, response });
      messages.push({ role: "assistant", content: response.content as MessageParam["content"] });
      if (response.stop_reason === "pause_turn") {
        appended = [];
        continue;
      }
      const uses = response.content.filter((b) => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || uses.length === 0) {
        status = "complete";
        break;
      }
      const results: Record<string, unknown>[] = [];
      let missed = false;
      // One at a time, so which recorded call answers which is deterministic.
      for (const use of uses) {
        const answer = await resolver.resolve({ name: use.name, input: use.input });
        answers.set(use.id, answer);
        if (answer.replay.tier === "unreplayable") missed = true;
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: toResultContent(answer.content),
          ...(answer.isError ? { is_error: true } : {}),
        });
      }
      const user = { role: "user", content: results } as unknown as MessageParam;
      messages.push(user);
      appended = [user];
      if (missed && config.replay.onMiss === "stop") {
        status = "unreplayable";
        break;
      }
    }
  } finally {
    if (ownLive) await live?.close();
  }

  const trace = buildTrace({
    id: newTraceId("rp"),
    createdAt: Date.now(),
    source: "replay",
    ...(baseline.label ? { label: baseline.label } : {}),
    status,
    request: { ...base, model: String(base.model), messages: baseline.request.messages },
    exchanges,
    replay: { baselineId: baseline.id, changes: describeChanges(changes), warnings, ...(error ? { error } : {}) },
  });
  // A replay that stopped on a miss has no next exchange carrying the results; take them from the answers.
  for (const step of trace.steps) {
    const a = answers.get(step.toolUseId);
    if (!a) continue;
    step.replay = a.replay as ReplayInfo;
    if (step.result === null) {
      step.result = a.content;
      step.isError = a.isError;
    }
  }
  return trace;
}

function describeChanges(c: Changes): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.model) out.model = c.model;
  if (c.system !== undefined) out.system = c.system.length > 200 ? `${c.system.slice(0, 200)}…` : c.system;
  if (c.toolDescriptions && Object.keys(c.toolDescriptions).length)
    out.toolDescriptions = Object.keys(c.toolDescriptions);
  if (c.removeTools?.length) out.removeTools = c.removeTools;
  if (c.params && Object.keys(c.params).length) out.params = c.params;
  return out;
}
