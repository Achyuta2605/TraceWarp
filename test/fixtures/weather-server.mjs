// A small MCP server for the live-tool tests. Run with: node test/fixtures/weather-server.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "weather-fixture", version: "1.0.0" });

server.registerTool(
  "get_weather",
  { description: "Current weather for a city", inputSchema: { city: z.string() } },
  async ({ city }) => ({ content: [{ type: "text", text: `live: 21C and clear in ${city}` }] }),
);

await server.connect(new StdioServerTransport());
