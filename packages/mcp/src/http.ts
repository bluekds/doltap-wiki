import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { WikiConfig } from "@bluekds/doltap-core";
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
}

export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

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

export interface RunningHttpServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Streamable HTTP endpoint for remote clients (claude.ai connectors, Claude Code --transport http).
 * Stateless: every request gets its own McpServer + transport, so no session bookkeeping is needed and
 * the git/sqlite work stays serialized on the single Node thread.
 */
export async function startHttpServer(cfg: WikiConfig, o: HttpOptions): Promise<RunningHttpServer> {
  const token = o.token ?? loadOrCreateToken(cfg);
  const maxBody = o.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowed = new Set(
    ["127.0.0.1", "localhost", "::1", "[::1]", o.host, ...(o.allowedHosts ?? (process.env.DOLTAP_HTTP_ALLOWED_HOSTS ?? "").split(","))]
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    const m = /^\/([^/]+)\/mcp$/.exec(url.pathname);
    if (!m || !tokenMatches(m[1], token)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }
    if (!hostAllowed(req.headers.host, allowed)) {
      res.writeHead(421, { "content-type": "text/plain" }).end("misdirected request: Host not allowed (set DOLTAP_HTTP_ALLOWED_HOSTS)\n");
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode has no server-initiated stream; GET/DELETE are not supported.
      res.writeHead(405, { allow: "POST", "content-type": "text/plain" }).end("method not allowed\n");
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req, maxBody);
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        // Answer, then discard the rest of the body instead of destroying the socket: a reset before the
        // client has read the response surfaces as ECONNRESET (Windows) rather than as a 413.
        res.writeHead(413, { "content-type": "text/plain", connection: "close" }).end("payload too large\n");
        req.resume();
      } else res.writeHead(400, { "content-type": "text/plain" }).end("bad request\n");
      return;
    }
    const server = createServer(cfg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
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
    close: () => new Promise<void>((resolve, reject) => { httpServer.closeAllConnections(); httpServer.close((e) => (e ? reject(e) : resolve())); }),
  };
}

export async function serveHttp(cfg: WikiConfig, o: HttpOptions): Promise<void> {
  const running = await startHttpServer(cfg, o);
  process.stderr.write(`doltap mcp http listening on http://${o.host}:${running.port}/<token>/mcp (token: doltap serve token)\n`);
  const shutdown = () => running.server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
