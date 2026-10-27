import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, type WikiConfig } from "@bluekds/doltap-core";
import { startHttpServer } from "../src/http.js";

const TOKEN = "ab".repeat(32);
let dir: string;
let cfg: WikiConfig;
let srv: Awaited<ReturnType<typeof startHttpServer>>;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "doltap-http-"));
  cpSync(fileURLToPath(new URL("../../core/test/fixtures/wiki/", import.meta.url)), join(dir, "wiki"), { recursive: true });
  cfg = resolveConfig({ root: dir, noSync: true, agent: "test" });
  writeFileSync(join(cfg.stateDir, "http-clients.json"), JSON.stringify({ laptop: { token: "cd".repeat(32), readOnly: true, created: "2026-10-27" } }));
  srv = await startHttpServer(cfg, { port: 0, host: "127.0.0.1", token: TOKEN, maxBodyBytes: 64 * 1024 });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("http transport", () => {
  it("answers initialize with the right token and 404 otherwise", async () => {
    const ok = await fetch(`${base}/${TOKEN}/mcp`, { method: "POST", headers, body: init });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).toContain("doltap");
    expect(text).toContain("instructions");
    expect(text).toContain("wiki_search");
    const wrong = await fetch(`${base}/${"ef".repeat(32)}/mcp`, { method: "POST", headers, body: init });
    expect(wrong.status).toBe(404);
    const short = await fetch(`${base}/x/mcp`, { method: "POST", headers, body: init });
    expect(short.status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("rejects oversized bodies with 413 before parsing", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wiki_search", arguments: { query: "x".repeat(200 * 1024) } } });
    const r = await fetch(`${base}/${TOKEN}/mcp`, { method: "POST", headers, body: big });
    expect(r.status).toBe(413);
  });

  // fetch drops a caller-set Host header (forbidden header), so use node:http with setHost=false.
  const postWithHost = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: srv.port, path: `/${TOKEN}/mcp`, method: "POST", setHost: false, headers: { ...headers, host } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(init);
    });

  it("rejects requests whose Host header is not allowed (DNS rebinding)", async () => {
    expect(await postWithHost("evil.example")).toBe(421);
    expect(await postWithHost("evil.example:8765")).toBe(421);
    expect(await postWithHost("box.tail1234.ts.net")).toBe(200);
    expect(await postWithHost("localhost:1234")).toBe(200);
  });
});

describe("per-client tokens", () => {
  const call = (token: string, name: string, args: Record<string, unknown>) =>
    fetch(`${base}/${token}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }) }).then((r) => r.text());
  it("a read-only client token can search but not write", async () => {
    const ro = "cd".repeat(32);
    expect(await call(ro, "wiki_search", { query: "obsidian" })).toContain("reference/obsidian-conventions");
    const w = await call(ro, "wiki_patch_section", { id: "reference/obsidian-conventions", section: "Details", content: "x" });
    expect(w).toContain("read-only");
    expect(w).toContain("isError");
  });
});
