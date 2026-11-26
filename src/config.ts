import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CONFIG_FILE_NAME } from "./brand.js";
import { PRESET_NAMES, PRESETS, presetTools } from "./presets.js";

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
 *   builtins:
 *     claudeCode: { enabled: true, root: . }   # run Claude Code's Read/Grep/Glob/LS for real, inside root
 *   servers:
 *     fs: { preset: filesystem, root: ./docs }    # a known server: its read-only tools go live (see presets.ts)
 *     docs: { command: [node, docs-server.js] }  # any other server: name the tools below
 *   tools:
 *     mcp__docs__search: { readOnly: true, live: docs }
 */

const serverSchema = z
  .strictObject({
    command: z.array(z.string()).min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    /** A known server (filesystem, git, fetch): TraceWarp starts it pinned and knows which of its tools only read. */
    preset: z.enum(PRESET_NAMES).optional(),
    /** The folder a preset server is confined to. Required for filesystem and git. */
    root: z.string().optional(),
    /** Let a preset's tools that reach the internet (fetch) run for real. Off by default. */
    openWorld: z.boolean().default(false),
    /** How the model names this server's tools. Default `mcp__<server>__`, as Claude Code and the Agent SDK do. */
    toolPrefix: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    if (!s.preset) {
      if (!s.command) ctx.addIssue({ code: "custom", path: ["command"], message: "give a command or a preset" });
      for (const k of ["root", "toolPrefix"] as const) {
        if (s[k] !== undefined) ctx.addIssue({ code: "custom", path: [k], message: `${k} needs a preset` });
      }
      if (s.openWorld) ctx.addIssue({ code: "custom", path: ["openWorld"], message: "openWorld needs a preset" });
      return;
    }
    const p = PRESETS[s.preset];
    if (p.usesRoot && !s.root) {
      ctx.addIssue({ code: "custom", path: ["root"], message: `the ${s.preset} preset needs a root folder` });
    }
    if (!p.usesRoot && s.root) {
      ctx.addIssue({ code: "custom", path: ["root"], message: `the ${s.preset} preset takes no root` });
    }
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
  /**
   * Answer every unrecorded call to this tool with a permission error, as the agent would have if it was not
   * allowed to use the tool when recorded (Claude Code's Bash under --allowedTools, say).
   */
  deny: z.boolean().default(false),
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
    builtins: z
      .strictObject({
        /**
         * Answer Claude Code's read-only tools (Read, Grep, Glob, LS) from the files on disk when the recording has
         * no answer. `root` is the folder they may read; by default, the folder the session was recorded in.
         */
        claudeCode: z.strictObject({ enabled: z.boolean().default(false), root: z.string().optional() }).prefault({}),
      })
      .prefault({}),
    servers: z.record(z.string(), serverSchema).default({}),
    tools: z.record(z.string(), toolSchema).default({}),
  })
  .transform(expandPresets)
  .superRefine((c, ctx) => {
    for (const [name, t] of Object.entries(c.tools)) {
      if (t.live && !t.readOnly) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", name, "live"],
          message: "live calls are only allowed for tools marked readOnly: true",
        });
      }
      if (t.deny && (t.live || t.readOnly)) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", name, "deny"],
          message: "a denied tool cannot also be readOnly or live",
        });
      }
      if (t.live && !c.servers[t.live]) {
        ctx.addIssue({ code: "custom", path: ["tools", name, "live"], message: `no server named "${t.live}"` });
      }
    }
  });

type RawConfig = {
  servers: Record<string, z.infer<typeof serverSchema>>;
  tools: Record<string, z.infer<typeof toolSchema>>;
};

/**
 * Turns each preset server into a command and live entries for its read-only tools. A tool the config already
 * names keeps the config's settings, so a preset tool can still be denied or switched off. Roots are resolved
 * against the current folder, as `cwd` is.
 */
function expandPresets<C extends RawConfig>(c: C): C {
  for (const [name, s] of Object.entries(c.servers)) {
    if (!s.preset) continue;
    const root = s.root ? resolve(s.root) : "";
    if (s.root) s.root = root;
    s.command ??= PRESETS[s.preset].command(root);
    for (const t of presetTools(name, { ...s, preset: s.preset })) {
      c.tools[t.name] ??= { readOnly: true, live: name, mcpName: t.mcpName, noSimulate: false, deny: false };
    }
  }
  return c;
}

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
  return config.tools[name] ?? { readOnly: false, noSimulate: false, deny: false };
}
