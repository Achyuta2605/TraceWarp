import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { DEFAULT_UPSTREAM, UPSTREAM_ENV_VAR } from "./brand.js";
import type { Recorder } from "./recorder.js";
import { messageFromSse } from "./sse.js";
import type { Message } from "./trace.js";

/**
 * Two ways to capture an agent's Messages API calls without changing what the agent sees:
 *  - recordingFetch: a fetch for `new Anthropic({ fetch })` in code you own;
 *  - startRecordingProxy: a local HTTP proxy for any agent that honours ANTHROPIC_BASE_URL.
 * Both pass every byte through unchanged and record a copy.
 */

/** Request headers kept with a trace because a replay needs them. Credentials are never kept. */
export const KEPT_HEADERS = ["anthropic-beta", "anthropic-version"] as const;

export function isMessagesCall(method: string, url: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const path = new URL(url, "http://x").pathname.replace(/\/+$/, "");
  return path.endsWith("/v1/messages");
}

export function keptHeaders(get: (name: string) => string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of KEPT_HEADERS) {
    const v = get(h);
    if (v) out[h] = v;
  }
  return out;
}

export class UnreadableResponseError extends Error {}

/**
 * Set on every request a TraceWarp proxy forwards and every replay request. A proxy that receives it refuses the
 * call, so a leftover ANTHROPIC_BASE_URL pointing at a proxy can never make it call itself, or record replays.
 */
export const LOOP_HEADER = "x-tracewarp-hop";

/**
 * Parses a recorded response body (JSON or SSE). Returns undefined for things that are not a message (API errors
 * are passed through, not recorded) and throws UnreadableResponseError for a message that could not be rebuilt.
 */
export function parseResponseBody(text: string, contentType: string | null): Message | undefined {
  if (contentType?.includes("text/event-stream")) {
    try {
      return messageFromSse(text);
    } catch (e) {
      throw new UnreadableResponseError(`could not rebuild a streamed reply: ${(e as Error).message}`);
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new UnreadableResponseError(`reply is not JSON: ${(e as Error).message}`);
  }
  return json && (json as Message).type === "message" ? (json as Message) : undefined;
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

function headerGetter(init: RequestInit | undefined, req: Request | undefined): (name: string) => string | null {
  const h = new Headers(req?.headers);
  if (init?.headers) {
    new Headers(init.headers).forEach((v, k) => {
      h.set(k, v);
    });
  }
  return (name) => h.get(name);
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
    const headers = keptHeaders(headerGetter(init, req));
    const startedAt = Date.now();
    const res = await inner(input, init);
    if (!body || !res.ok || !res.body) return res;
    const [mine, theirs] = res.body.tee();
    void new Response(mine)
      .text()
      .then((text) => {
        const message = parseResponseBody(text, res.headers.get("content-type"));
        if (message)
          recorder.record({ body, headers, response: message, startedAt, latencyMs: Date.now() - startedAt });
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
  /** Stops accepting calls, waits up to `graceMs` (default 10 s) for the ones in flight, aborts the rest, closes. */
  close: (graceMs?: number) => Promise<void>;
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

/**
 * Where calls go: TRACEWARP_UPSTREAM, then the ANTHROPIC_BASE_URL the agent would have used (a company gateway,
 * say), then the public API. A --upstream flag beats all three.
 */
export function defaultUpstream(env: NodeJS.ProcessEnv = process.env): string {
  return env[UPSTREAM_ENV_VAR] || env.ANTHROPIC_BASE_URL || DEFAULT_UPSTREAM;
}

/** Resolves when `res` can take more data or has closed, without leaving a listener behind. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

/** Starts a local proxy in front of the Anthropic API. Point the agent's ANTHROPIC_BASE_URL at `url`. */
export async function startRecordingProxy(
  recorder: Recorder,
  opts: CaptureErrors & { port?: number; host?: string; upstream?: string } = {},
): Promise<RecordingProxy> {
  const upstream = (opts.upstream ?? defaultUpstream()).replace(/\/+$/, "");
  // No header or body timeouts: a long non-streaming call can legitimately take many minutes. Honours HTTPS_PROXY.
  const dispatcher = new EnvHttpProxyAgent({ headersTimeout: 0, bodyTimeout: 0 });
  let calls = 0;
  const inFlight = new Set<Promise<void>>();
  const aborts = new Set<AbortController>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    calls++;
    if (req.headers[LOOP_HEADER]) {
      req.resume();
      res.writeHead(508, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message:
              "TraceWarp proxy received a call from TraceWarp itself (a loop, or a replay sent to a recording proxy). Check ANTHROPIC_BASE_URL and TRACEWARP_UPSTREAM.",
          },
        }),
      );
      return;
    }
    const abort = new AbortController();
    aborts.add(abort);
    res.on("close", () => aborts.delete(abort));
    let clientGone = false;
    res.on("close", () => {
      if (!res.writableFinished) {
        clientGone = true;
        abort.abort();
      }
    });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_HEADERS.has(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    // Ask for an uncompressed body so the copy we keep can be parsed.
    headers["accept-encoding"] = "identity";
    headers[LOOP_HEADER] = "1";
    const method = req.method ?? "GET";
    const target = `${upstream}${req.url ?? "/"}`;
    const startedAt = Date.now();
    let upstreamRes: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      upstreamRes = await undiciFetch(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : raw,
        redirect: "manual",
        signal: abort.signal,
        dispatcher,
      });
    } catch (e) {
      if (clientGone) return;
      opts.onError?.(e as Error);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `TraceWarp proxy could not reach ${upstream}: ${(e as Error).message}` },
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
    try {
      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body as AsyncIterable<Uint8Array>) {
          const buf = Buffer.from(chunk);
          if (record) kept.push(buf);
          if (!res.write(buf)) await drained(res);
          if (clientGone) return;
        }
      }
    } catch (e) {
      if (clientGone) return;
      // The upstream broke mid-reply. Break the client's connection too, so it cannot mistake a cut-off
      // stream for a complete one.
      opts.onError?.(new Error(`upstream reply was cut off: ${(e as Error).message}`));
      res.destroy(e as Error);
      return;
    }
    res.end();
    if (!record || clientGone) return;
    const body = parseBody(raw.toString("utf8"));
    if (!body) return;
    try {
      const message = parseResponseBody(Buffer.concat(kept).toString("utf8"), upstreamRes.headers.get("content-type"));
      if (message) {
        recorder.record({
          body,
          headers: keptHeaders((n) => req.headers[n] as string | undefined),
          response: message,
          startedAt,
          latencyMs: Date.now() - startedAt,
        });
      }
    } catch (e) {
      opts.onError?.(e as Error);
    }
  };

  const server: Server = createServer((req, res) => {
    const p = handle(req, res)
      .catch((e: Error) => {
        opts.onError?.(e);
        if (!res.headersSent) res.writeHead(502);
        res.destroy();
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
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
    close: async (graceMs = 10_000) => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      });
      await Promise.race([Promise.allSettled([...inFlight]), deadline]);
      clearTimeout(timer);
      // Calls still running after the grace period (a stuck upstream) are cut off.
      for (const a of aborts) a.abort();
      server.closeAllConnections();
      await Promise.allSettled([...inFlight]);
      await closed;
      await dispatcher.close();
    },
  };
}
