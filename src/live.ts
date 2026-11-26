import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServerConfig } from "./config.js";
import { PRESETS } from "./presets.js";

/**
 * Real MCP servers for "live" answers: read-only tool calls that a replay had no recording for. One connection per
 * server, opened on first use and closed when the replay ends.
 */
export class LiveTools {
  private readonly clients = new Map<string, Promise<Client>>();

  constructor(private readonly servers: Record<string, ServerConfig>) {}

  async call(server: string, tool: string, args: unknown): Promise<{ content: unknown; isError: boolean }> {
    const client = await this.connect(server);
    const result = await client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> });
    return { content: result.content ?? [], isError: result.isError === true };
  }

  private connect(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const cfg = this.servers[name];
    if (!cfg?.command?.length) return Promise.reject(new Error(`no server named "${name}"`));
    const [command, ...args] = cfg.command as [string, ...string[]];
    const transport = new StdioClientTransport({
      command,
      args,
      // The SDK's safe default set (PATH, HOME, ...) plus what the config names; not every secret in our env.
      env: { ...getDefaultEnvironment(), ...cfg.env },
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      stderr: "ignore",
    });
    const client = new Client({ name: "tracewarp-live", version: "1" });
    const p = client
      .connect(transport)
      .then(() => client)
      .catch((e: Error) => {
        const hint =
          cfg.preset && /ENOENT/.test(e.message)
            ? ` (the ${cfg.preset} preset needs ${PRESETS[cfg.preset].install})`
            : "";
        throw new Error(`could not start server "${name}": ${e.message}${hint}`);
      });
    this.clients.set(name, p);
    return p;
  }

  async close(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((p) => p.then((c) => c.close()).catch(() => undefined)));
  }
}

/** Claude Code and similar clients expose MCP tools as `mcp__<server>__<tool>`. */
export function mcpToolName(modelName: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(modelName);
  return m ? (m[1] as string) : modelName;
}
