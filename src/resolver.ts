import { type Config, toolConfig } from "./config.js";
import { canonical, inputSimilarity } from "./json.js";
import { type LiveTools, mcpToolName } from "./live.js";
import type { Provider } from "./provider.js";
import type { ReplayInfo, ToolStep } from "./trace.js";

/**
 * Answers the tool calls a replayed model makes, trying each tier in order and saying which one answered:
 *   exact      the same call was recorded
 *   fuzzy      a close enough call was recorded (same tool, similar arguments)
 *   live       the tool is read-only and configured to run for real
 *   simulated  a model invented a plausible result (off by default)
 *   unreplayable  nothing could answer it
 * Recorded calls are consumed in order, so a call made twice is answered by the two recorded results in turn.
 */

export interface ToolAnswer {
  content: unknown;
  isError: boolean;
  replay: ReplayInfo;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface ResolverOptions {
  config: Config;
  /** Tool definitions from the request, used to brief the simulator. */
  tools?: unknown[];
  live?: LiveTools;
  simulator?: Provider;
}

export const UNREPLAYABLE_MESSAGE =
  "TraceWarp: this call was not in the recording, so there is no result to give back. (Replay could not answer it.)";

export class Resolver {
  private readonly used = new Set<number>();

  constructor(
    private readonly recorded: ToolStep[],
    private readonly opts: ResolverOptions,
  ) {}

  async resolve(call: ToolCall): Promise<ToolAnswer> {
    const candidates = this.recorded
      .map((step, index) => ({ step, index }))
      .filter((c) => c.step.name === call.name && c.step.result !== null);

    const key = canonical(call.input);
    const exact = this.pick(candidates.filter((c) => canonical(c.step.input) === key));
    if (exact) return this.answer(exact, { tier: "exact" });

    // A read-only live tool gives the true answer, which beats a recorded result for a merely similar call.
    const tool = toolConfig(this.opts.config, call.name);
    let liveError: string | undefined;
    if (tool.live && tool.readOnly && this.opts.live) {
      try {
        const r = await this.opts.live.call(tool.live, tool.mcpName ?? mcpToolName(call.name), call.input);
        return { content: r.content, isError: r.isError, replay: { tier: "live" } };
      } catch (e) {
        // A server that is down should not make a call unreplayable when the recording can still answer it.
        liveError = `live call failed: ${(e as Error).message}`;
      }
    }

    const threshold = this.opts.config.replay.fuzzyThreshold;
    const scored = candidates
      .map((c) => ({ ...c, similarity: inputSimilarity(c.step.input, call.input) }))
      .filter((c) => c.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity);
    const fuzzy = this.pick(scored);
    if (fuzzy) {
      return this.answer(fuzzy, {
        tier: "fuzzy",
        similarity: round(fuzzy.similarity),
        ...(liveError ? { note: liveError } : {}),
      });
    }

    if (this.opts.config.replay.simulate && !tool.noSimulate && this.opts.simulator) {
      try {
        return await this.simulate(call);
      } catch (e) {
        return this.miss(`simulation failed: ${(e as Error).message}`);
      }
    }
    return this.miss(
      liveError ??
        (candidates.length
          ? "recorded calls to this tool had different arguments"
          : "tool never called in the recording"),
    );
  }

  /** Prefers a recorded call not used yet; falls back to reusing one. */
  private pick<T extends { index: number }>(list: T[]): (T & { reused: boolean }) | undefined {
    const fresh = list.find((c) => !this.used.has(c.index));
    if (fresh) return { ...fresh, reused: false };
    const again = list[0];
    return again ? { ...again, reused: true } : undefined;
  }

  private answer(c: { step: ToolStep; index: number; reused: boolean }, info: ReplayInfo): ToolAnswer {
    this.used.add(c.index);
    return {
      content: c.step.result,
      isError: c.step.isError,
      replay: { ...info, matchedStep: c.index, ...(c.reused ? { reused: true } : {}) },
    };
  }

  private miss(note: string): ToolAnswer {
    return { content: UNREPLAYABLE_MESSAGE, isError: true, replay: { tier: "unreplayable", note } };
  }

  private async simulate(call: ToolCall): Promise<ToolAnswer> {
    const def = (this.opts.tools ?? []).find((t) => (t as { name?: string }).name === call.name);
    const examples = this.recorded
      .filter((s) => s.name === call.name && s.result !== null)
      .slice(0, 3)
      .map((s) => ({ input: s.input, result: s.result }));
    const prompt = [
      "You stand in for a software tool during a test replay. Write the result this tool would most likely return for",
      "the call below. Match the format of the recorded examples when there are any. Reply with the tool result only,",
      "no explanation.",
      "",
      `Tool definition: ${JSON.stringify(def ?? { name: call.name })}`,
      `Recorded examples: ${JSON.stringify(examples)}`,
      `Call input: ${JSON.stringify(call.input)}`,
    ].join("\n");
    const reply = await (this.opts.simulator as Provider).create({
      model: this.opts.config.replay.simulateModel,
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = reply.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    return { content: text, isError: false, replay: { tier: "simulated", note: `by ${reply.model}` } };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
