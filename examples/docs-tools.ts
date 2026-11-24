/**
 * The three read-only tools of the example file agent, shared by the agent itself (examples/file-agent.ts) and by
 * an MCP server that serves the same tools (examples/docs-mcp-server.ts), so TraceWarp can call them live.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

export const tools: Anthropic.Tool[] = [
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

function inside(base: string, path: string): string {
  // Real paths, so a symlink inside the folder cannot point outside it.
  const full = realpathSync(resolve(base, path));
  base = realpathSync(base);
  if (full !== base && !full.startsWith(base + sep)) throw new Error("path is outside the folder");
  return full;
}

export function runTool(root: string, name: string, input: Record<string, unknown>): string {
  const base = resolve(root);
  switch (name) {
    case "list_files":
      return files(base)
        .map((f) => `${relative(base, f)} (${statSync(f).size} bytes)`)
        .join("\n");
    case "read_file":
      return readFileSync(inside(base, String(input.path)), "utf8");
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
