import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callLogPath, resolveConfig, type WikiConfig } from "@bluekds/doltap-core";
import { assertClientName, assertTokenFormat, rotateToken, startHttpServer, tokenPath } from "../src/http.js";

/**
 * 0.9.1 security audit S10–S14: unauthenticated hits are counted, not logged one by one; a client can only
 * evict its own sessions; a rotated token takes effect without a restart; `mcp-http` is reserved; the token
 * argument is checked.
 */
let dir: string;
let cfg: WikiConfig;
let srv: Awaited<ReturnType<typeof startHttpServer>>;
let base: string;
const RO = "cd".repeat(32);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "doltap-http-"));
  cpSync(fileURLToPath(new URL("../../core/test/fixtures/wiki/", import.meta.url)), join(dir, "wiki"), { recursive: true });
  cfg = resolveConfig({ root: dir, noSync: true, agent: "test" });
  writeFileSync(join(cfg.stateDir, "http-clients.json"), JSON.stringify({ laptop: { token: RO, readOnly: true, created: "2026-10-27" } }));
  // No `token` option: the server reads (and creates) .doltap/http-token, which is what the service does.
  srv = await startHttpServer(cfg, { port: 0, host: "127.0.0.1", unauthFlushMs: 150, maxSessionsPerClient: 2 });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const token = () => readFileSync(tokenPath(cfg), "utf8").trim();
const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const initialize = async (t: string) => {
  const r = await fetch(`${base}/${t}/mcp`, { method: "POST", headers, body: init });
  await r.text();
  return { status: r.status, sid: r.headers.get("mcp-session-id") };
};
const ping = async (t: string, sid: string) => {
  const r = await fetch(`${base}/${t}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) });
  await r.text();
  return r.status;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("S10: unauthenticated requests are aggregated", () => {
  it("writes one summary line per flush instead of one line per 404", async () => {
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/${"ef".repeat(32)}/mcp`, { method: "POST", headers, body: init })).status).toBe(404);
    const before = (() => { try { return readFileSync(callLogPath(cfg), "utf8"); } catch { return ""; } })();
    expect(before.split("\n").filter((l) => l.includes("no-token"))).toHaveLength(0);
    await sleep(400);
    const after = readFileSync(callLogPath(cfg), "utf8").split("\n").filter((l) => l.includes("no-token"));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/5_requests/);
  });
});

describe("S11: a client can only evict its own sessions", () => {
  it("the third session of one client drops that client's oldest, never another client's", async () => {
    const ro = await initialize(RO);
    expect(ro.status).toBe(200);
    const a = await initialize(token());
    const b = await initialize(token());
    const c = await initialize(token());
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(await ping(token(), a.sid!)).toBe(404);
    expect(await ping(token(), b.sid!)).toBe(200);
    expect(await ping(token(), c.sid!)).toBe(200);
    expect(await ping(RO, ro.sid!)).toBe(200);
  });
});

describe("S12: token rotation", () => {
  it("takes effect on the running server; the old token stops working; the file is replaced atomically", async () => {
    const old = token();
    expect((await initialize(old)).status).toBe(200);
    const fresh = rotateToken(cfg);
    expect(fresh).not.toBe(old);
    expect(token()).toBe(fresh);
    // Give the mtime check one request to notice.
    expect((await initialize(old)).status).toBe(404);
    expect((await initialize(fresh)).status).toBe(200);
  });
});

describe("S14: names and formats", () => {
  it("mcp-http cannot be issued as a client name; a token argument must be 64 hex", () => {
    expect(() => assertClientName("mcp-http")).toThrow(/reserved/);
    expect(() => assertClientName("scheduler")).toThrow(/reserved/);
    expect(() => assertClientName("Laptop")).toThrow(/kebab-case/);
    expect(() => assertClientName("laptop-2")).not.toThrow();
    expect(() => assertTokenFormat("short")).toThrow(/64 hex/);
    expect(() => assertTokenFormat("ab".repeat(32))).not.toThrow();
  });
});
