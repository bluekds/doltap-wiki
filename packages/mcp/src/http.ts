import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { WikiConfig } from "@bluekds/doltap-core";
import { createServer } from "./server.js";

export interface HttpOptions {
  port: number;
  host: string;
  /** Secret path segment: requests go to /<token>/mcp. Generated and stored in .doltap/http-token when omitted. */
  token?: string;
}

export function tokenPath(cfg: WikiConfig): string {
  return join(cfg.stateDir, "http-token");
}

/** Read the stored token or create a new 256-bit one (file mode 0600). */
export function loadOrCreateToken(cfg: WikiConfig): string {
  const p = tokenPath(cfg);
  if (existsSync(p)) {
    const t = readFileSync(p, "utf8").trim();
    if (t.length >= 32) return t;
  }
  const t = randomBytes(32).toString("hex");
  writeFileSync(p, t + "\n", { mode: 0o600 });
  return t;
}

export function rotateToken(cfg: WikiConfig): string {
  const t = randomBytes(32).toString("hex");
  writeFileSync(tokenPath(cfg), t + "\n", { mode: 0o600 });
  return t;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/**
 * Streamable HTTP endpoint for remote clients (claude.ai connectors, Claude Code --transport http).
 * Stateless: every request gets its own McpServer + transport, so no session bookkeeping is needed and
 * the git/sqlite work stays serialized on the single Node thread.
 */
export async function serveHttp(cfg: WikiConfig, o: HttpOptions): Promise<void> {
  const token = o.token ?? loadOrCreateToken(cfg);
  const mcpPath = `/${token}/mcp`;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    if (url.pathname !== mcpPath) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode has no server-initiated stream; GET/DELETE are not supported.
      res.writeHead(405, { allow: "POST", "content-type": "text/plain" }).end("method not allowed\n");
      return;
    }
    const server = createServer(cfg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      const body = await readJsonBody(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: e instanceof Error ? e.message : String(e) }, id: null }));
      }
    }
  };

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(o.port, o.host, resolve));
  process.stderr.write(`doltap mcp http listening on http://${o.host}:${o.port}/<token>/mcp (token: doltap serve token)\n`);
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
