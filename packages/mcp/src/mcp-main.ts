import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "@bluekds/doltap-core";
import { createServer } from "./server.js";
import { defaultSession, serveHttp } from "./http.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// Identity recorded in commit messages. Clients can override via env when launching the server.
// The stdio server gets a session of its own (DOLTAP_SESSION / CLAUDE_CODE_SESSION_ID override it); the HTTP server sets one per client and day.
// The HTTP server pushes in the background (DOLTAP_DEFER_PUSH=0 restores synchronous pushes); stdio servers push with each write.
const http = args.includes("--http");
const cfg = resolveConfig({
  agent: process.env.DOLTAP_AGENT ?? (http ? "mcp-http" : "mcp"),
  session: http ? undefined : defaultSession(),
  deferPush: http ? process.env.DOLTAP_DEFER_PUSH !== "0" : undefined,
});

if (http) {
  await serveHttp(cfg, {
    port: Number(flag("--port") ?? process.env.DOLTAP_HTTP_PORT ?? 8765),
    host: flag("--host") ?? process.env.DOLTAP_HTTP_HOST ?? "127.0.0.1",
    token: flag("--token") ?? process.env.DOLTAP_HTTP_TOKEN,
  });
} else {
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
}
