import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { fakeMessage } from "../src/provider.js";
import { buildTrace, type Exchange, type MessageParam, type Trace } from "../src/trace.js";

export const ROOT = resolve(import.meta.dirname, "..");
export const CLI = join(ROOT, "dist", "cli.js");
export const WEATHER_SERVER = join(ROOT, "test", "fixtures", "weather-server.mjs");

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tracewarp-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let toolId = 0;
export function toolUse(name: string, input: unknown, id = `toolu_${++toolId}`): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } } as unknown as Anthropic.ToolUseBlock;
}

export function text(t: string): Anthropic.TextBlock {
  return { type: "text", text: t, citations: null } as Anthropic.TextBlock;
}

/** The SSE stream the Messages API would send for this message. */
export function sseFor(m: Anthropic.Message): string {
  const ev = (type: string, data: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
  let out = ev("message_start", {
    message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 1 } },
  });
  m.content.forEach((b, index) => {
    if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      const half = Math.ceil(b.text.length / 2);
      for (const part of [b.text.slice(0, half), b.text.slice(half)]) {
        out += ev("content_block_delta", { index, delta: { type: "text_delta", text: part } });
      }
    } else if (b.type === "tool_use") {
      out += ev("content_block_start", { index, content_block: { ...b, input: {} } });
      const json = JSON.stringify(b.input);
      const half = Math.ceil(json.length / 2);
      for (const part of [json.slice(0, half), json.slice(half)]) {
        out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: part } });
      }
    } else {
      out += ev("content_block_start", { index, content_block: b });
    }
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", {
    delta: { stop_reason: m.stop_reason, stop_sequence: null },
    usage: { output_tokens: m.usage.output_tokens },
  });
  out += ev("message_stop", {});
  return out;
}

export interface FakeApi {
  url: string;
  bodies: Record<string, unknown>[];
  close: () => Promise<void>;
}

/** A stand-in for the Messages API. `reply` decides each response from the request body. */
export async function fakeApi(reply: (body: Record<string, unknown>) => Partial<Anthropic.Message>): Promise<FakeApi> {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "nope" } }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.push(body);
      const m = fakeMessage({ model: body.model, ...reply(body) });
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseFor(m));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(m));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/**
 * Builds a recorded trace from a scripted conversation: each turn is the model's reply, and tool results are
 * produced by `tools` for every tool_use in it.
 */
export function recordedTrace(opts: {
  task: string;
  turns: Anthropic.ContentBlock[][];
  tools: (name: string, input: Record<string, unknown>) => string;
  model?: string;
  id?: string;
}): Trace {
  const model = opts.model ?? "claude-sonnet-5-5";
  const exchanges: Exchange[] = [];
  let appended: MessageParam[] = [];
  opts.turns.forEach((content, i) => {
    const response = fakeMessage({ model, content });
    exchanges.push({ startedAt: 1_000 + i * 10, latencyMs: 500, appended, response });
    const uses = content.filter((b) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    appended = uses.length
      ? [
          {
            role: "user",
            content: uses.map((u) => ({
              type: "tool_result" as const,
              tool_use_id: u.id,
              content: opts.tools(u.name, u.input as Record<string, unknown>),
            })),
          },
        ]
      : [];
  });
  return buildTrace({
    id: opts.id ?? `tw_test${++toolId}`,
    createdAt: 1_000,
    source: "sdk",
    status: "complete",
    request: {
      model,
      max_tokens: 1000,
      system: "You are a test agent.",
      tools: [
        { name: "get_weather", description: "Weather for a city", input_schema: { type: "object" } },
        { name: "search", description: "Search", input_schema: { type: "object" } },
      ],
      messages: [{ role: "user", content: opts.task }],
    },
    exchanges,
  });
}

/** Runs a command without blocking this process (the fake API in the test must keep answering). */
export function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}
