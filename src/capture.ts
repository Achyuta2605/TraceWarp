import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_UPSTREAM, UPSTREAM_ENV_VAR } from "./brand.js";
import type { Recorder } from "./recorder.js";
import { messageFromSse } from "./sse.js";
import type { Message } from "./trace.js";

/**
 * Two ways to capture an agent's Messages API calls without changing what the agent sees:
 *  - recordingFetch: a fetch for `new Anthropic({ fetch })` in code you own;
 *  - startRecordingProxy: a local HTTP proxy for any agent that honours ANTHROPIC_BASE_URL.
 * Both pass every byte through unchanged and record a copy in the background.
 */

export function isMessagesCall(method: string, url: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const path = new URL(url, "http://x").pathname.replace(/\/+$/, "");
  return path.endsWith("/v1/messages");
}

/** Parses a recorded response body (JSON or SSE). Returns undefined for errors and other non-messages. */
export function parseResponseBody(text: string, contentType: string | null): Message | undefined {
  try {
    if (contentType?.includes("text/event-stream")) return messageFromSse(text);
    const json = JSON.parse(text) as Message;
    return json && json.type === "message" ? json : undefined;
  } catch {
    return undefined;
  }
}

function parseBody(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export interface CaptureErrors {
  /** Called when a call could not be recorded. Recording never breaks the agent. */
  onError?: (e: Error) => void;
}

/** A fetch that records Messages API calls made through it. */
export function recordingFetch(recorder: Recorder, opts: CaptureErrors & { fetch?: typeof fetch } = {}): typeof fetch {
  const inner = opts.fetch ?? globalThis.fetch;
  return async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const method = init?.method ?? req?.method ?? "GET";
    if (!isMessagesCall(method, url)) return inner(input, init);
    const bodyText = typeof init?.body === "string" ? init.body : req ? await req.clone().text() : undefined;
    const body = parseBody(bodyText);
    const startedAt = Date.now();
    const res = await inner(input, init);
    if (!body || !res.ok || !res.body) return res;
    const [mine, theirs] = res.body.tee();
    void new Response(mine)
      .text()
      .then((text) => {
        const message = parseResponseBody(text, res.headers.get("content-type"));
        if (message) recorder.record({ body, response: message, startedAt, latencyMs: Date.now() - startedAt });
      })
      .catch((e: Error) => opts.onError?.(e));
    return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

export interface RecordingProxy {
  url: string;
  port: number;
  /** Calls seen so far (recorded or not). */
  calls: () => number;
  close: () => Promise<void>;
}

const HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "accept-encoding",
  "proxy-connection",
  "upgrade",
]);

/** Starts a local proxy in front of the Anthropic API. Point the agent's ANTHROPIC_BASE_URL at `url`. */
export async function startRecordingProxy(
  recorder: Recorder,
  opts: CaptureErrors & { port?: number; host?: string; upstream?: string; fetch?: typeof fetch } = {},
): Promise<RecordingProxy> {
  const upstream = (opts.upstream ?? process.env[UPSTREAM_ENV_VAR] ?? DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  let calls = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_HEADERS.has(k.toLowerCase())) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    // Ask for an uncompressed body so the copy we keep can be parsed.
    headers.set("accept-encoding", "identity");
    const method = req.method ?? "GET";
    const target = `${upstream}${req.url ?? "/"}`;
    const startedAt = Date.now();
    let upstreamRes: Response;
    try {
      upstreamRes = await doFetch(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : raw,
        redirect: "manual",
      });
    } catch (e) {
      opts.onError?.(e as Error);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `TraceWarp proxy: ${(e as Error).message}` },
        }),
      );
      return;
    }
    const outHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((v, k) => {
      if (!HOP_HEADERS.has(k) && k !== "content-encoding") outHeaders[k] = v;
    });
    res.writeHead(upstreamRes.status, upstreamRes.statusText, outHeaders);
    const record = isMessagesCall(method, target) && upstreamRes.ok;
    const kept: Buffer[] = [];
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        if (record) kept.push(buf);
        res.write(buf);
      }
    }
    res.end();
    if (!record) return;
    const body = parseBody(raw.toString("utf8"));
    const message = parseResponseBody(Buffer.concat(kept).toString("utf8"), upstreamRes.headers.get("content-type"));
    if (body && message) recorder.record({ body, response: message, startedAt, latencyMs: Date.now() - startedAt });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      opts.onError?.(e);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    port,
    calls: () => calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
