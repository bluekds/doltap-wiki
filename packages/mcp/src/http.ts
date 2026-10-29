import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { appendCall, pushPendingAsync, readSyncState, type SyncReport, type WikiConfig } from "@bluekds/doltap-core";
import { createServer } from "./server.js";

export interface HttpOptions {
  port: number;
  host: string;
  /** Secret path segment: requests go to /<token>/mcp. Generated and stored in .doltap/http-token when omitted. */
  token?: string;
  /** Largest accepted request body. Default 2 MiB; a page is a few KB. */
  maxBodyBytes?: number;
  /**
   * Host headers to accept besides loopback names, the bind host and `*.ts.net` (Tailscale). Default from
   * $DOLTAP_HTTP_ALLOWED_HOSTS (comma-separated). Anything else gets 421, which defeats DNS rebinding.
   */
  allowedHosts?: string[];
  /** A session that made no request for this long is closed. Default 2 hours. */
  sessionIdleMs?: number;
  /** How often the background flusher looks for a pending push when cfg.deferPush is set. Default 20 s. */
  flushIntervalMs?: number;
}

export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const MAX_SESSIONS = 500;

export function tokenPath(cfg: WikiConfig): string {
  return join(cfg.stateDir, "http-token");
}

function writeToken(p: string, t: string): void {
  writeFileSync(p, t + "\n", { mode: 0o600 });
  chmodSync(p, 0o600); // `mode` only applies when the file is created; rotation must tighten an existing file too
}

/** Read the stored token or create a new 256-bit one (file mode 0600). */
export function loadOrCreateToken(cfg: WikiConfig): string {
  const p = tokenPath(cfg);
  if (existsSync(p)) {
    const t = readFileSync(p, "utf8").trim();
    if (t.length >= 32) return t;
  }
  const t = randomBytes(32).toString("hex");
  writeToken(p, t);
  return t;
}

export function rotateToken(cfg: WikiConfig): string {
  const t = randomBytes(32).toString("hex");
  writeToken(tokenPath(cfg), t);
  return t;
}

/** Named client tokens besides the default one: `.doltap/http-clients.json` → { name: { token, readOnly, created, expires? } }. */
export interface HttpClient {
  token: string;
  readOnly: boolean;
  created: string;
  /** Last day the token works (YYYY-MM-DD, inclusive). Absent: never expires. */
  expires?: string;
}

export function clientsPath(cfg: WikiConfig): string {
  return join(cfg.stateDir, "http-clients.json");
}

/** Client names land in commit trailers (`[agent:<name>]`), so they are kebab-case tokens only. */
export const CLIENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function loadClients(cfg: WikiConfig): Record<string, HttpClient> {
  const p = clientsPath(cfg);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, HttpClient>;
    const out: Record<string, HttpClient> = {};
    for (const [name, c] of Object.entries(raw)) {
      if (!CLIENT_NAME_RE.test(name) || typeof c?.token !== "string") {
        process.stderr.write(`doltap mcp http: ignoring client ${JSON.stringify(name)} in http-clients.json (name must match ${CLIENT_NAME_RE})\n`);
        continue;
      }
      out[name] = c;
    }
    return out;
  } catch { return {}; }
}

/** A client whose `expires` day has passed (compared as YYYY-MM-DD strings in UTC). */
export function clientExpired(c: HttpClient, now = Date.now()): boolean {
  return typeof c.expires === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.expires) && c.expires < new Date(now).toISOString().slice(0, 10);
}

/**
 * Session id for a server process when the environment gives none: one per process for stdio (one agent
 * session launches one server), so "the session that created a page cannot verify it" holds without setup.
 */
let processSession: string | undefined;
export function defaultSession(): string {
  const env = process.env.DOLTAP_SESSION ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (env) return env;
  processSession ??= `mcp-${randomBytes(6).toString("hex")}`;
  return processSession;
}

/** Fallback for a client that never sent an MCP session id (pre-0.6 behaviour): the client plus the day. */
export function httpSession(agent: string): string {
  return `${agent}@${new Date().toISOString().slice(0, 10)}`;
}

/** Session recorded in commits for a stateful MCP session: `<client>/<first 8 hex of the Mcp-Session-Id>`. */
export function mcpSession(agent: string, sessionId: string): string {
  return `${agent}/${sessionId.replace(/-/g, "").slice(0, 8)}`;
}

export function saveClients(cfg: WikiConfig, clients: Record<string, HttpClient>): void {
  const p = clientsPath(cfg);
  writeFileSync(p, JSON.stringify(clients, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
}

export interface ResolvedClient {
  /** Agent name recorded in commits: the client name, or "mcp-http" for the default token. */
  agent: string;
  readOnly: boolean;
  /** The token matched a client whose `expires` day has passed; it must be refused. */
  expired: boolean;
}

/** Which client a path token belongs to (constant-time compare against every token); null when none. */
export function resolveClient(given: string, defaultToken: string, clients: Record<string, HttpClient>, now = Date.now()): ResolvedClient | null {
  let found: ResolvedClient | null = null;
  if (tokenMatches(given, defaultToken)) found = { agent: "mcp-http", readOnly: false, expired: false };
  for (const [name, c] of Object.entries(clients)) if (tokenMatches(given, c.token)) found = { agent: name, readOnly: !!c.readOnly, expired: clientExpired(c, now) };
  return found;
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time comparison of the path token (hashing first hides the length as well). */
export function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

export function hostAllowed(hostHeader: string | undefined, allowed: Set<string>): boolean {
  if (!hostHeader) return true; // HTTP/1.0 clients; rebinding attacks always carry a browser-set Host
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
  return allowed.has(host) || host.endsWith(".ts.net");
}

class BodyTooLarge extends Error {}

async function readJsonBody(req: IncomingMessage, max: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > max) throw new BodyTooLarge();
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/** JSON-RPC method and tool name of a request body (first message of a batch), for the call log and routing. */
function describeBody(body: unknown): { method: string; tool: string; isInitialize: boolean } {
  const first = (Array.isArray(body) ? body[0] : body) as { method?: unknown; params?: { name?: unknown } } | undefined;
  const method = typeof first?.method === "string" ? first.method : "-";
  const tool = method === "tools/call" && typeof first?.params?.name === "string" ? first.params.name : "-";
  return { method, tool, isInitialize: method === "initialize" };
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  agent: string;
  last: number;
}

export interface RunningHttpServer {
  server: Server;
  port: number;
  /** Open MCP sessions (stateful clients). */
  sessionCount(): number;
  /** Push now if a write left a commit pending (cfg.deferPush); resolves with the last push report when the attempt finished. */
  flush(): Promise<SyncReport | null>;
  close(): Promise<void>;
}

/**
 * Streamable HTTP endpoint for remote clients (claude.ai connectors, Claude Code --transport http, Codex,
 * Cursor, Gemini CLI). A client that initializes gets an `Mcp-Session-Id` and its own McpServer for the
 * life of the session, so the session recorded in commits is the client's conversation, not the day.
 * A request without a session id (older clients, one-shot callers) is served statelessly as before.
 * The git/sqlite work stays serialized on the single Node thread; with cfg.deferPush the push runs in
 * the background so a write returns as soon as its commit is made.
 */
export async function startHttpServer(cfg: WikiConfig, o: HttpOptions): Promise<RunningHttpServer> {
  const token = o.token ?? loadOrCreateToken(cfg);
  const maxBody = o.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const idleMs = o.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const clientsFile = clientsPath(cfg);
  let clientsMtime = -1;
  let clients: Record<string, HttpClient> = {};
  const currentClients = () => {
    // Re-read when the file changes so `doltap serve client add` takes effect without a restart.
    let mtime = -1;
    try { mtime = statSync(clientsFile).mtimeMs; } catch { /* no file */ }
    if (mtime !== clientsMtime) { clients = loadClients(cfg); clientsMtime = mtime; }
    return clients;
  };
  const allowed = new Set(
    ["127.0.0.1", "localhost", "::1", "[::1]", o.host, ...(o.allowedHosts ?? (process.env.DOLTAP_HTTP_ALLOWED_HOSTS ?? "").split(","))]
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );

  // ---- MCP sessions
  const sessions = new Map<string, Session>();
  const dropSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.transport.close().catch(() => {});
    s.server.close().catch(() => {});
  };
  const evict = () => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.last > idleMs) dropSession(id);
    if (sessions.size > MAX_SESSIONS) {
      for (const [id] of [...sessions.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, sessions.size - MAX_SESSIONS)) dropSession(id);
    }
  };
  const evictTimer = setInterval(evict, Math.min(idleMs, 5 * 60 * 1000));
  evictTimer.unref();

  // ---- background push (cfg.deferPush)
  // One flush at a time. A flush requested while one runs sets `rerun`, so a commit made during a push is
  // pushed by the pass that follows instead of being left behind with pendingPush cleared.
  let flushing: Promise<SyncReport | null> | null = null;
  let rerun = false;
  let lastFlush: SyncReport | null = null;
  const flush = (): Promise<SyncReport | null> => {
    if (!cfg.deferPush) return Promise.resolve(null);
    if (flushing) { rerun = true; return flushing; }
    flushing = (async () => {
      // Yield once: an async function with nothing to await would finish (and clear `flushing`) before the
      // assignment above ran, leaving a resolved promise in place and every later flush a no-op.
      await Promise.resolve();
      try {
        do {
          rerun = false;
          if (!readSyncState(cfg).pendingPush) continue;
          lastFlush = await pushPendingAsync(cfg);
          for (const m of lastFlush.messages) process.stderr.write(`doltap mcp http: background push: ${m}\n`);
        } while (rerun);
      } catch (e) {
        process.stderr.write(`doltap mcp http: background push failed: ${e instanceof Error ? e.message : String(e)}\n`);
      } finally { flushing = null; }
      return lastFlush;
    })();
    return flushing;
  };
  const flushTimer = cfg.deferPush ? setInterval(() => { flush().catch(() => {}); }, o.flushIntervalMs ?? 20_000) : null;
  flushTimer?.unref();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    const log = (client: string, method: string, tool: string, status: string) => {
      try { appendCall(cfg, { ts: new Date(started).toISOString(), client, method, tool, status, ms: Date.now() - started }); } catch { /* logging never fails a request */ }
    };
    const m = /^\/([^/]+)\/mcp$/.exec(url.pathname);
    const client = m ? resolveClient(m[1], token, currentClients()) : null;
    if (!client || client.expired) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      log(client?.agent ?? "-", "-", "-", client ? "expired" : "no-token");
      return;
    }
    if (!hostAllowed(req.headers.host, allowed)) {
      res.writeHead(421, { "content-type": "text/plain" }).end("misdirected request: Host not allowed (set DOLTAP_HTTP_ALLOWED_HOSTS)\n");
      log(client.agent, "-", "-", "421");
      return;
    }
    const sidHeader = req.headers["mcp-session-id"];
    const sid = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;
    const existing = sid ? sessions.get(sid) : undefined;
    if (sid && !existing) {
      // Unknown or evicted session: the SDK's answer for an invalid id, so clients re-initialize.
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "session not found; initialize again" }, id: null }));
      log(client.agent, "-", "-", "404");
      return;
    }
    if (existing && existing.agent !== client.agent) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      log(client.agent, "-", "-", "404");
      return;
    }
    if (req.method !== "POST" && !existing) {
      // Without a session there is no server-initiated stream to GET and nothing to DELETE.
      res.writeHead(405, { allow: "POST", "content-type": "text/plain" }).end("method not allowed\n");
      log(client.agent, "-", "-", "405");
      return;
    }
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req, maxBody);
      } catch (e) {
        if (e instanceof BodyTooLarge) {
          // Answer, then discard the rest of the body instead of destroying the socket: a reset before the
          // client has read the response surfaces as ECONNRESET (Windows) rather than as a 413.
          res.writeHead(413, { "content-type": "text/plain", connection: "close" }).end("payload too large\n");
          req.resume();
        } else res.writeHead(400, { "content-type": "text/plain" }).end("bad request\n");
        log(client.agent, "-", "-", String(res.statusCode));
        return;
      }
    }
    const { method, tool, isInitialize } = describeBody(body);
    res.on("finish", () => {
      log(client.agent, req.method === "POST" ? method : req.method ?? "-", tool, String(res.statusCode));
      if (method === "tools/call" && cfg.deferPush && readSyncState(cfg).pendingPush) setTimeout(() => { flush().catch(() => {}); }, 500).unref();
    });

    let server: McpServer;
    let transport: StreamableHTTPServerTransport;
    if (existing) {
      existing.last = Date.now();
      ({ server, transport } = existing);
    } else if (isInitialize) {
      // Stateful: the session id goes back in the Mcp-Session-Id header and names the session in commits.
      const id = randomUUID();
      server = createServer({ ...cfg, agent: client.agent, session: mcpSession(client.agent, id) }, { readOnly: client.readOnly });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
      sessions.set(id, { transport, server, agent: client.agent, last: Date.now() });
      transport.onclose = () => dropSession(id);
      if (sessions.size > MAX_SESSIONS) evict();
    } else {
      // Stateless fallback (no session id): one McpServer per request, session = client plus day.
      server = createServer({ ...cfg, agent: client.agent, session: httpSession(client.agent) }, { readOnly: client.readOnly });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    }
    try {
      if (!existing) await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      // Details (paths, git stderr) go to the service log, not to the remote caller.
      process.stderr.write(`doltap mcp http: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error (see the server log)" }, id: null }));
      }
    }
  };

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(o.port, o.host, resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  return {
    server: httpServer,
    port,
    sessionCount: () => sessions.size,
    flush,
    close: async () => {
      clearInterval(evictTimer);
      if (flushTimer) clearInterval(flushTimer);
      for (const id of [...sessions.keys()]) dropSession(id);
      await new Promise<void>((resolve, reject) => { httpServer.closeAllConnections(); httpServer.close((e) => (e ? reject(e) : resolve())); });
    },
  };
}

export async function serveHttp(cfg: WikiConfig, o: HttpOptions): Promise<void> {
  const running = await startHttpServer(cfg, o);
  process.stderr.write(`doltap mcp http listening on http://${o.host}:${running.port}/<token>/mcp (token: doltap serve token)${cfg.deferPush ? "; pushes run in the background" : ""}\n`);
  const shutdown = () => {
    // Push what a write left pending before the process goes away; the scheduler's sync covers the rest.
    const bye = () => running.close().finally(() => process.exit(0));
    if (cfg.deferPush) running.flush().finally(bye); else bye();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
