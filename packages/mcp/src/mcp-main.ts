import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "@doltap/core";
import { createServer } from "./server.js";
import { serveHttp } from "./http.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// Identity recorded in commit messages. Clients can override via env when launching the server.
const cfg = resolveConfig({ agent: process.env.DOLTAP_AGENT ?? (args.includes("--http") ? "mcp-http" : "mcp") });

if (args.includes("--http")) {
  await serveHttp(cfg, {
    port: Number(flag("--port") ?? process.env.DOLTAP_HTTP_PORT ?? 8765),
    host: flag("--host") ?? process.env.DOLTAP_HTTP_HOST ?? "127.0.0.1",
    token: flag("--token") ?? process.env.DOLTAP_HTTP_TOKEN,
  });
} else {
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
}
