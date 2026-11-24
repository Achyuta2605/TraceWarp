/**
 * A small but real agent, used for TraceWarp's tests and demo: it answers questions about a folder of files with
 * three tools (list_files, read_file, search). It talks to the Claude API through the official SDK, so
 * `tracewarp record -- npx tsx examples/file-agent.ts <folder> "<question>"` records it with no code changes.
 *
 *   ANTHROPIC_API_KEY=... npx tsx examples/file-agent.ts ./docs "Which file explains the retry policy?"
 *   FILE_AGENT_MODEL=claude-haiku-5-5 ...   picks the model (default claude-sonnet-5-5)
 */
import Anthropic from "@anthropic-ai/sdk";
import { runTool, tools } from "./docs-tools.js";

const [root = ".", ...questionWords] = process.argv.slice(2);
const question = questionWords.join(" ") || "What is in this folder?";
const model = process.env.FILE_AGENT_MODEL || "claude-sonnet-5-5";

const client = new Anthropic();
const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
const system =
  "You answer questions about a folder of text files. Use the tools to look before you answer. Cite file names. Keep the answer short.";

for (let turn = 0; turn < 12; turn++) {
  const response = await client.messages.create({ model, max_tokens: 4000, system, tools, messages });
  messages.push({ role: "assistant", content: response.content });
  if (response.stop_reason !== "tool_use") {
    for (const b of response.content) if (b.type === "text") console.log(b.text);
    break;
  }
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const b of response.content) {
    if (b.type !== "tool_use") continue;
    try {
      results.push({
        type: "tool_result",
        tool_use_id: b.id,
        content: runTool(root, b.name, b.input as Record<string, unknown>),
      });
    } catch (e) {
      results.push({ type: "tool_result", tool_use_id: b.id, content: (e as Error).message, is_error: true });
    }
  }
  messages.push({ role: "user", content: results });
}
