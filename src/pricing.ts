/**
 * Anthropic first-party list prices in USD per million tokens. Used to compare the cost of a recorded run with
 * its replay; numbers are estimates, not a bill. Unknown models cost nothing rather than a guess.
 */
export interface Price {
  input: number;
  output: number;
  /** Cache reads. Defaults to 10% of input. */
  cacheRead?: number;
  /** Cache writes (5-minute TTL). Defaults to 125% of input. */
  cacheWrite?: number;
}

export const PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-mythos-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-mythos-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function priceFor(model: string): Price | undefined {
  if (PRICES[model]) return PRICES[model];
  // Suffixed and cloud ids: "claude-opus-5-5[1m]", "us.anthropic.claude-haiku-4-5-20251001-v1:0" (Bedrock),
  // "claude-haiku-4-5@20251001" (Vertex).
  const bare = model
    .replace(/^([a-z]{2,6}\.)?anthropic\./, "")
    .replace(/\[.*\]$/, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/@(\d{8})$/, "-$1");
  if (PRICES[bare]) return PRICES[bare];
  // Only a date suffix (claude-haiku-4-5-20251001) maps to the base id; "claude-opus-5-9" is not opus-5.
  const dated = /^(.*)-\d{8}$/.exec(bare);
  return dated ? PRICES[dated[1] as string] : undefined;
}

/** Estimated cost in USD, or null when the model is not in the price table. */
export function costUsd(model: string, usage: TokenUsage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  const cacheWrite = p.cacheWrite ?? p.input * 1.25;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) /
    1_000_000
  );
}
