import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CONFIG_FILE_NAME } from "./brand.js";

/**
 * tracewarp.yaml: how replays answer tool calls that were never recorded.
 *
 *   replay:
 *     fuzzyThreshold: 0.85   # how alike a call must be to a recorded one to reuse its result
 *     onMiss: stop           # stop | continue (send the model an error and keep going)
 *     simulate: false        # let a cheap model invent results for calls with no recording
 *     simulateModel: claude-haiku-5-5
 *     maxTurns: 50
 *   judge:
 *     enabled: false         # a Claude judge rules on final answers (see judge.ts)
 *     model: claude-sonnet-5-5
 *   servers:
 *     fs: { command: [npx, -y, "@modelcontextprotocol/server-filesystem", "."] }
 *   tools:
 *     mcp__fs__read_text_file: { readOnly: true, live: fs }
 */

const serverSchema = z.strictObject({
  command: z.array(z.string()).min(1),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const toolSchema = z.strictObject({
  /** Calling the real tool cannot change anything. Required for live calls. */
  readOnly: z.boolean().default(false),
  /** Server (from `servers`) to call for live answers. */
  live: z.string().optional(),
  /** The tool's name on that MCP server, when it differs from the name the model uses. */
  mcpName: z.string().optional(),
  /** Never simulate this tool even when simulation is on. */
  noSimulate: z.boolean().default(false),
});

const configSchema = z
  .strictObject({
    replay: z
      .strictObject({
        fuzzyThreshold: z.number().min(0).max(1).default(0.85),
        onMiss: z.enum(["stop", "continue"]).default("stop"),
        simulate: z.boolean().default(false),
        simulateModel: z.string().default("claude-haiku-5-5"),
        maxTurns: z.number().int().positive().default(50),
      })
      .prefault({}),
    judge: z
      .strictObject({
        /** Let a Claude judge decide whether final answers changed, instead of the key-facts check. */
        enabled: z.boolean().default(false),
        model: z.string().default("claude-sonnet-5-5"),
      })
      .prefault({}),
    servers: z.record(z.string(), serverSchema).default({}),
    tools: z.record(z.string(), toolSchema).default({}),
  })
  .superRefine((c, ctx) => {
    for (const [name, t] of Object.entries(c.tools)) {
      if (t.live && !t.readOnly) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", name, "live"],
          message: "live calls are only allowed for tools marked readOnly: true",
        });
      }
      if (t.live && !c.servers[t.live]) {
        ctx.addIssue({ code: "custom", path: ["tools", name, "live"], message: `no server named "${t.live}"` });
      }
    }
  });

export type Config = z.infer<typeof configSchema>;
export type ToolConfig = z.infer<typeof toolSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;

export class ConfigError extends Error {}

export function parseConfig(text: string, origin = CONFIG_FILE_NAME): Config {
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (e) {
    throw new ConfigError(`${origin}: ${(e as Error).message}`);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`${origin} has problems:\n${lines.join("\n")}`);
  }
  return result.data;
}

export function defaultConfig(): Config {
  return parseConfig("{}");
}

/** Loads the given file, or ./tracewarp.yaml if it exists, or the defaults. */
export function loadConfig(path?: string): Config {
  const file = path ? resolve(path) : resolve(CONFIG_FILE_NAME);
  if (!existsSync(file)) {
    if (path) throw new ConfigError(`config file not found: ${file}`);
    return defaultConfig();
  }
  return parseConfig(readFileSync(file, "utf8"), file);
}

export function toolConfig(config: Config, name: string): ToolConfig {
  return config.tools[name] ?? { readOnly: false, noSimulate: false };
}
