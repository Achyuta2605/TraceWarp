/**
 * The example file agent's tools as an MCP server, so a replay can answer calls the recording never saw by calling
 * the real (read-only) tools. See examples/tracewarp.yaml.
 *
 *   node --import tsx examples/docs-mcp-server.ts examples/demo-docs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runTool } from "./docs-tools.js";

const root = process.argv[2] ?? ".";
const server = new McpServer({ name: "demo-docs", version: "1.0.0" });

const answer = (name: string, input: Record<string, unknown>) => {
  try {
    return { content: [{ type: "text" as const, text: runTool(root, name, input) }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
  }
};

server.registerTool(
  "list_files",
  { description: "Lists every file under the folder, with sizes in bytes." },
  async () => answer("list_files", {}),
);
server.registerTool(
  "read_file",
  { description: "Reads one file. Paths are relative to the folder.", inputSchema: { path: z.string() } },
  async ({ path }) => answer("read_file", { path }),
);
server.registerTool(
  "search",
  { description: "Finds lines containing a word or phrase across all files.", inputSchema: { query: z.string() } },
  async ({ query }) => answer("search", { query }),
);

await server.connect(new StdioServerTransport());
