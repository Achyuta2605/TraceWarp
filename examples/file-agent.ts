/**
 * A small but real agent, used for TraceWarp's tests and demo: it answers questions about a folder of files with
 * three tools (list_files, read_file, search). It talks to the Claude API through the official SDK, so
 * `tracewarp record -- npx tsx examples/file-agent.ts <folder> "<question>"` records it with no code changes.
 *
 *   ANTHROPIC_API_KEY=... npx tsx examples/file-agent.ts ./docs "Which file explains the retry policy?"
 *   FILE_AGENT_MODEL=claude-haiku-5-5 ...   picks the model (default claude-sonnet-5-5)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const [root = ".", ...questionWords] = process.argv.slice(2);
const question = questionWords.join(" ") || "What is in this folder?";
const base = resolve(root);
const model = process.env.FILE_AGENT_MODEL || "claude-sonnet-5-5";

const tools: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "Lists every file under the folder, with sizes in bytes.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Reads one file. Paths are relative to the folder.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "relative path, e.g. notes/a.md" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Finds lines containing a word or phrase (case-insensitive) across all files.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function inside(path: string): string {
  const full = resolve(base, path);
  if (full !== base && !full.startsWith(base + sep)) throw new Error("path is outside the folder");
  return full;
}

function runTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "list_files":
      return files(base)
        .map((f) => `${relative(base, f)} (${statSync(f).size} bytes)`)
        .join("\n");
    case "read_file":
      return readFileSync(inside(String(input.path)), "utf8");
    case "search": {
      const q = String(input.query).toLowerCase();
      const hits: string[] = [];
      for (const f of files(base)) {
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (line.toLowerCase().includes(q)) hits.push(`${relative(base, f)}:${i + 1}: ${line.trim()}`);
          });
      }
      return hits.slice(0, 50).join("\n") || "no matches";
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

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
        content: runTool(b.name, b.input as Record<string, unknown>),
      });
    } catch (e) {
      results.push({ type: "tool_result", tool_use_id: b.id, content: (e as Error).message, is_error: true });
    }
  }
  messages.push({ role: "user", content: results });
}
