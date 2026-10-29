import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCalls, readSyncState, resolveConfig, type WikiConfig } from "@bluekds/doltap-core";
import { makeTwoMachines, sh } from "../../core/test/helpers.js";
import { clientExpired, mcpSession, resolveClient, startHttpServer } from "../src/http.js";

const TOKEN = "ab".repeat(32);
const LAPTOP = "cd".repeat(32);
const OLD = "ef".repeat(32);
let m: ReturnType<typeof makeTwoMachines>;
let cfg: WikiConfig;
let srv: Awaited<ReturnType<typeof startHttpServer>>;
let base: string;

beforeAll(async () => {
  m = makeTwoMachines();
  cfg = resolveConfig({ root: m.a, agent: "test", deferPush: true });
  writeFileSync(
    join(cfg.stateDir, "http-clients.json"),
    JSON.stringify({ laptop: { token: LAPTOP, readOnly: false, created: "2026-10-01", expires: "2999-01-01" }, old: { token: OLD, readOnly: false, created: "2026-01-01", expires: "2026-02-01" } }),
  );
  srv = await startHttpServer(cfg, { port: 0, host: "127.0.0.1", token: TOKEN, flushIntervalMs: 60_000 });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv.close();
  m.cleanup();
});

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
async function open(token: string): Promise<string> {
  const r = await fetch(`${base}/${token}/mcp`, { method: "POST", headers, body: init });
  expect(r.status).toBe(200);
  const sid = r.headers.get("mcp-session-id");
  expect(sid).toMatch(/^[0-9a-f-]{36}$/);
  await fetch(`${base}/${token}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": sid! }, body: initialized });
  return sid!;
}
const call = (token: string, sid: string | null, name: string, args: Record<string, unknown>) =>
  fetch(`${base}/${token}/mcp`, { method: "POST", headers: sid ? { ...headers, "mcp-session-id": sid } : headers, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }) });
const text = (r: Response) => r.text();
const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";

describe("MCP sessions over HTTP (0.6)", () => {
  it("initialize opens a session; writes in it carry <client>/<session> and the same session cannot verify its own page", async () => {
    const sid = await open(LAPTOP);
    expect(srv.sessionCount()).toBeGreaterThanOrEqual(1);
    const up = await call(LAPTOP, sid, "wiki_upsert", { id: "howto/http-session", title: "Session page", summary: "Created in an MCP session.", tags: ["wiki"], body, force: true }).then(text);
    expect(up).not.toContain("isError");
    const log = sh(m.a, "git", ["log", "-1", "--format=%B"]);
    expect(log).toContain(`[session:${mcpSession("laptop", sid)}]`);
    expect(log).toMatch(/\[session:laptop\/[0-9a-f]{8}\]/);
    const self = await call(LAPTOP, sid, "wiki_verify", { id: "howto/http-session", evidence: "I just made it" }).then(text);
    expect(self).toContain("same session");
    // Another session of the same client is another conversation and may verify.
    const sid2 = await open(LAPTOP);
    expect(sid2).not.toBe(sid);
    const other = await call(LAPTOP, sid2, "wiki_verify", { id: "howto/http-session", evidence: "followed it in a second conversation" }).then(text);
    expect(other).not.toContain("isError");
  });

  it("a request without a session id is served statelessly with the client-plus-day session", async () => {
    const r = await call(LAPTOP, null, "wiki_upsert", { id: "howto/http-stateless", title: "Stateless", summary: "Created without a session id.", tags: ["wiki"], body, force: true });
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(sh(m.a, "git", ["log", "-1", "--format=%B"])).toMatch(/\[session:laptop@\d{4}-\d{2}-\d{2}\]/);
  });

  it("an unknown session id is 404, a session of another token is 404, DELETE closes a session", async () => {
    const sid = await open(LAPTOP);
    const before = srv.sessionCount();
    expect((await call(LAPTOP, "00000000-0000-4000-8000-000000000000", "wiki_search", { query: "x" })).status).toBe(404);
    expect((await call(TOKEN, sid, "wiki_search", { query: "x" })).status).toBe(404);
    const del = await fetch(`${base}/${LAPTOP}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid } });
    expect([200, 204]).toContain(del.status);
    expect(srv.sessionCount()).toBe(before - 1);
    expect((await call(LAPTOP, sid, "wiki_search", { query: "x" })).status).toBe(404);
    expect((await fetch(`${base}/${LAPTOP}/mcp`, { method: "GET", headers })).status).toBe(405);
  });
});

describe("client expiry and call log (0.6)", () => {
  it("an expired client token is refused with 404 and logged as expired", async () => {
    expect(clientExpired({ token: "x", readOnly: false, created: "2026-01-01", expires: "2026-02-01" }, Date.parse("2026-02-02T00:00:00Z"))).toBe(true);
    expect(clientExpired({ token: "x", readOnly: false, created: "2026-01-01", expires: "2026-02-01" }, Date.parse("2026-02-01T23:00:00Z"))).toBe(false);
    expect(resolveClient(OLD, TOKEN, { old: { token: OLD, readOnly: false, created: "2026-01-01", expires: "2026-02-01" } })).toMatchObject({ agent: "old", expired: true });
    const r = await fetch(`${base}/${OLD}/mcp`, { method: "POST", headers, body: init });
    expect(r.status).toBe(404);
    const calls = readCalls(cfg, "2000-01-01");
    expect(calls.find((c) => c.client === "old")?.status).toBe("expired");
    expect(calls.some((c) => c.client === "laptop" && c.method === "tools/call" && c.tool === "wiki_upsert" && c.status === "200")).toBe(true);
    expect(calls.some((c) => c.client === "-" || c.status === "no-token")).toBe(false);
    const raw = readFileSync(join(cfg.stateDir, "logs", "http-calls.log"), "utf8");
    expect(raw).not.toContain(LAPTOP);
    expect(raw).not.toContain("Session page");
  });
});

describe("background push (0.6)", () => {
  it("a write returns after the commit; the flusher pushes it to the remote", async () => {
    const before = sh(m.bare, "git", ["rev-list", "--count", "main"]);
    const sid = await open(LAPTOP);
    const up = await call(LAPTOP, sid, "wiki_upsert", { id: "howto/http-deferred", title: "Deferred", summary: "Pushed in the background.", tags: ["wiki"], body, force: true }).then(text);
    expect(up).not.toContain("isError");
    expect(up).toContain("deferred");
    expect(readSyncState(cfg).pendingPush).toBe(true);
    await srv.flush();
    expect(readSyncState(cfg).pendingPush).toBe(false);
    expect(Number(sh(m.bare, "git", ["rev-list", "--count", "main"]))).toBeGreaterThan(Number(before));
    expect(sh(m.bare, "git", ["log", "-1", "--format=%s", "main"])).toContain("howto/http-deferred");
  });

  it("a push rejected because someone else pushed first pulls and pushes again", async () => {
    sh(m.b, "git", ["pull", "-q"]);
    writeFileSync(join(m.b, "wiki", "howto", "from-b.md"), "---\ntitle: From B\ncategory: howto\nsummary: Written on B.\ntags:\n  - wiki\nconfidence: draft\ncreated: 2026-10-29\nupdated: 2026-10-29\nsources: []\n---\n## Steps\n\n1. b\n");
    sh(m.b, "git", ["add", "-A"]);
    sh(m.b, "git", ["commit", "-q", "-m", "wiki: add howto/from-b"]);
    sh(m.b, "git", ["push", "-q"]);
    const sid = await open(LAPTOP);
    await call(LAPTOP, sid, "wiki_upsert", { id: "howto/http-deferred-2", title: "Deferred two", summary: "Pushed after a rejected push.", tags: ["wiki"], body, force: true }).then(text);
    const rep = await srv.flush();
    expect(rep?.pushed ?? false).toBe(true);
    expect(readSyncState(cfg).pendingPush).toBe(false);
    const remote = sh(m.bare, "git", ["log", "--format=%s", "main"]);
    expect(remote).toContain("howto/http-deferred-2");
    expect(remote).toContain("howto/from-b");
  });
});
