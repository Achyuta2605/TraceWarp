import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonical } from "./json.js";
import { mcpToolName } from "./live.js";
import type { Trace } from "./trace.js";

type DatabaseCtor = typeof import("better-sqlite3");

/** better-sqlite3 is optional (a native module): it is only loaded when an AgentOverwatch log is read. */
function loadSqlite(): DatabaseCtor {
  try {
    return createRequire(import.meta.url)("better-sqlite3") as DatabaseCtor;
  } catch (e) {
    throw new Error(
      `reading an AgentOverwatch log needs the optional better-sqlite3 package (npm install better-sqlite3): ${(e as Error).message}`,
    );
  }
}

/**
 * Reads the call log of AgentOverwatch (the MCP security gateway) and attaches what it knows to recorded tool
 * calls: which MCP server answered, how long the server took, and whether the gateway blocked the call.
 * The log is opened read-only and never changed.
 */

export function defaultOverwatchDb(): string {
  return process.env.AGENTOVERWATCH_DB || join(homedir(), ".agentoverwatch", "agentoverwatch.db");
}

interface CallRow {
  server_name: string;
  tool_name: string | null;
  request_json: string | null;
  status: string;
  started_at: number;
  duration_ms: number | null;
}

export interface EnrichResult {
  matched: number;
  /** Tool calls in these traces that had no server yet. */
  unmatched: number;
  /** Traces that gained at least one match. */
  changed: Trace[];
}

/** How far (ms) a gateway call may be from the model turn that asked for it and still match. */
const WINDOW_MS = 10 * 60 * 1000;

export function enrichFromOverwatch(traces: Trace[], dbPath: string = defaultOverwatchDb()): EnrichResult {
  if (!existsSync(dbPath)) throw new Error(`no AgentOverwatch log at ${dbPath}`);
  const Database = loadSqlite();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const stmt = db.prepare(
      `SELECT s.server_name, c.tool_name, c.request_json, c.status, c.started_at, c.duration_ms
       FROM calls c JOIN sessions s ON s.id = c.session_id
       WHERE c.method = 'tools/call' AND c.started_at BETWEEN ? AND ? ORDER BY c.started_at`,
    );
    const taken = new Set<string>();
    let matched = 0;
    let unmatched = 0;
    const changed: Trace[] = [];
    for (const trace of traces) {
      const start = trace.exchanges[0]?.startedAt ?? trace.createdAt;
      const end = (trace.exchanges.at(-1)?.startedAt ?? start) + (trace.exchanges.at(-1)?.latencyMs ?? 0);
      const rows = stmt.all(start - WINDOW_MS, end + WINDOW_MS) as CallRow[];
      let any = false;
      for (const step of trace.steps) {
        if (step.server) continue;
        const askedAt = trace.exchanges[step.turn]?.startedAt ?? start;
        const want = canonical(step.input ?? {});
        const short = mcpToolName(step.name);
        const hit = rows
          .filter((r) => {
            const id = `${r.server_name}|${r.started_at}|${r.request_json}`;
            if (taken.has(id) || r.tool_name !== short) return false;
            return canonical(argsOf(r.request_json)) === want;
          })
          .sort((x, y) => Math.abs(x.started_at - askedAt) - Math.abs(y.started_at - askedAt))[0];
        if (!hit) {
          unmatched++;
          continue;
        }
        taken.add(`${hit.server_name}|${hit.started_at}|${hit.request_json}`);
        step.server = hit.server_name;
        if (hit.duration_ms !== null) step.mcpLatencyMs = hit.duration_ms;
        if (hit.status === "blocked") step.isError = true;
        matched++;
        any = true;
      }
      if (any) changed.push(trace);
    }
    return { matched, unmatched, changed };
  } finally {
    db.close();
  }
}

function argsOf(requestJson: string | null): unknown {
  if (!requestJson) return {};
  try {
    const params = JSON.parse(requestJson) as { arguments?: unknown };
    return params.arguments ?? {};
  } catch {
    return undefined;
  }
}
