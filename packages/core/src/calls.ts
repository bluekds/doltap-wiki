import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WikiConfig } from "./config.js";
import { logDir } from "./logs.js";

/**
 * One line per HTTP request, written by the HTTP MCP server to `.doltap/logs/http-calls.log` (rotated with
 * the other service logs). Records who called which tool and how it went; never the arguments, never a token.
 */
export interface CallRecord {
  ts: string;
  /** Client name, "mcp-http" for the default token, "-" when the token matched nobody. */
  client: string;
  /** JSON-RPC method ("tools/call", "initialize", …) or "-" for non-JSON-RPC requests. */
  method: string;
  /** Tool name for tools/call, "-" otherwise. */
  tool: string;
  /** HTTP status sent, or a short reason such as "expired" / "no-token". */
  status: string;
  ms: number;
}

export function callLogPath(cfg: WikiConfig): string {
  return join(logDir(cfg), "http-calls.log");
}

const FIELD = (s: string) => (s || "-").replace(/\s+/g, "_").slice(0, 80);

export function appendCall(cfg: WikiConfig, r: CallRecord): void {
  mkdirSync(logDir(cfg), { recursive: true });
  appendFileSync(callLogPath(cfg), `${r.ts} ${FIELD(r.client)} ${FIELD(r.method)} ${FIELD(r.tool)} ${FIELD(r.status)} ${Math.round(r.ms)}\n`);
}

/** Parse the current log and its rotated generations (`http-calls.log.1`, …), oldest first, from `sinceIso` on. */
export function readCalls(cfg: WikiConfig, sinceIso: string): CallRecord[] {
  const dir = logDir(cfg);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((n) => /^http-calls\.log(\.\d+)?$/.test(n))
    .sort((a, b) => Number(b.split(".").pop() ?? 0) - Number(a.split(".").pop() ?? 0) || (a.endsWith(".log") ? 1 : -1));
  const out: CallRecord[] = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      const [ts, client, method, tool, status, ms] = line.split(" ");
      if (!ts || !status || ts < sinceIso) continue;
      out.push({ ts, client, method, tool, status, ms: Number(ms) || 0 });
    }
  }
  return out;
}

export interface CallSummaryRow {
  client: string;
  calls: number;
  /** Tool name → count, most used first. */
  tools: [string, number][];
  errors: number;
  last: string;
}

export function summarizeCalls(calls: CallRecord[]): CallSummaryRow[] {
  const by = new Map<string, { calls: number; tools: Map<string, number>; errors: number; last: string }>();
  for (const c of calls) {
    const row = by.get(c.client) ?? { calls: 0, tools: new Map(), errors: 0, last: "" };
    row.calls += 1;
    if (c.tool !== "-") row.tools.set(c.tool, (row.tools.get(c.tool) ?? 0) + 1);
    if (!/^2\d\d$/.test(c.status)) row.errors += 1;
    if (c.ts > row.last) row.last = c.ts;
    by.set(c.client, row);
  }
  return [...by.entries()]
    .map(([client, r]) => ({ client, calls: r.calls, tools: [...r.tools.entries()].sort((a, b) => b[1] - a[1]), errors: r.errors, last: r.last }))
    .sort((a, b) => b.calls - a.calls);
}
