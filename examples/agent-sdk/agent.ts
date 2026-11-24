/**
 * A Claude Agent SDK agent for on-call questions. It reads the docs folder with Claude Code's read-only tools and
 * asks a custom in-process MCP tool who owns a service. Record it with TraceWarp:
 *
 *   tracewarp record -- npx tsx agent.ts ../demo-docs "Who owns refunds, and what does R-500 mean?"
 *
 * The Agent SDK runs Claude Code, which reads ANTHROPIC_BASE_URL, so the recording proxy sees every call.
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const OWNERS: Record<string, string> = {
  payments: "Payments team (#payments-oncall)",
  refunds: "Ledger team (#ledger-oncall); refunds older than 120 days go to finance-ops",
  checkout: "Checkout team (#checkout-oncall)",
};

const owners = createSdkMcpServer({
  name: "owners",
  version: "1.0.0",
  tools: [
    tool(
      "service_owner",
      "Who owns a service and how to reach them. Services: payments, refunds, checkout.",
      { service: z.string() },
      async ({ service }) => ({
        content: [{ type: "text", text: OWNERS[service.toLowerCase()] ?? `No owner on file for "${service}".` }],
      }),
      { annotations: { readOnlyHint: true } },
    ),
  ],
});

const [folder, question] = process.argv.slice(2);
if (!folder || !question) {
  console.error("usage: tsx agent.ts <docs-folder> <question>");
  process.exit(3);
}

for await (const message of query({
  prompt: question,
  options: {
    cwd: folder,
    model: process.env.AGENT_MODEL ?? "claude-sonnet-5-5",
    systemPrompt: "You answer on-call questions from the docs in the working folder. Cite the file you used.",
    mcpServers: { owners },
    allowedTools: ["Read", "Grep", "Glob", "mcp__owners__service_owner"],
    // Nothing else may run: no Bash, no edits.
    disallowedTools: ["Bash", "Edit", "Write"],
    settingSources: [],
    maxTurns: 12,
  },
})) {
  if (message.type === "result") {
    console.log(message.subtype === "success" ? message.result : `agent stopped: ${message.subtype}`);
  }
}
