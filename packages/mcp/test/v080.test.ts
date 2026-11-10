import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSync, existsSync, openSync, unlinkSync, writeSync } from "node:fs";
import { resolveConfig, writeLockPath, type WikiConfig } from "@bluekds/doltap-core";
import { makeTwoMachines, sh } from "../../core/test/helpers.js";
import { startHttpServer } from "../src/http.js";

/**
 * 0.8: a write that waits for the machine's write lock must not stall the HTTP server. Before 0.8 the
 * wait was a synchronous Atomics.wait loop (up to 30 s) inside the request handler, so every other
 * client's search hung with it.
 */
const TOKEN = "ab".repeat(32);
let m: ReturnType<typeof makeTwoMachines>;
let cfg: WikiConfig;
let srv: Awaited<ReturnType<typeof startHttpServer>>;
let base: string;

beforeAll(async () => {
  m = makeTwoMachines();
  cfg = resolveConfig({ root: m.a, agent: "test", deferPush: true });
  srv = await startHttpServer(cfg, { port: 0, host: "127.0.0.1", token: TOKEN, flushIntervalMs: 60_000 });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv.close();
  m.cleanup();
});

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const call = (name: string, args: Record<string, unknown>, id = 9) =>
  fetch(`${base}/${TOKEN}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) }).then((r) => r.text());
const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hold the write lock as a live foreign writer would: the file names our own pid, so it is never treated as stale. */
function holdLock(): () => void {
  const p = writeLockPath(cfg);
  const fd = openSync(p, "wx");
  writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  closeSync(fd);
  return () => { if (existsSync(p)) unlinkSync(p); };
}

describe("writes wait for the lock without blocking readers (0.8)", () => {
  it("a search answers while an upsert is queued behind another writer; the upsert completes once the lock is released", async () => {
    const release = holdLock();
    try {
      let upsertDone = false;
      const upsert = call("wiki_upsert", { id: "howto/queued", title: "Queued", summary: "Written while another writer held the lock.", tags: ["wiki"], body, force: true }, 1).finally(() => { upsertDone = true; });
      await wait(150);
      // Order, not a wall-clock bound (slow CI runners took over a second): the search must answer while the
      // upsert is still waiting. A blocking wait would hold the event loop until the lock timeout, so the
      // upsert would finish (with an error) before the search got an answer.
      const search = await call("wiki_search", { query: "wiki" }, 2);
      expect(search).not.toContain("isError");
      expect(upsertDone).toBe(false);
      // Two queued writes in one process take turns; neither runs inside the other.
      const second = call("wiki_upsert", { id: "howto/queued-two", title: "Queued two", summary: "Second write queued behind the same lock.", tags: ["wiki"], body, force: true }, 3);
      await wait(100);
      release();
      const [u1, u2] = await Promise.all([upsert, second]);
      expect(u1).not.toContain("isError");
      expect(u2).not.toContain("isError");
      expect(sh(m.a, "git", ["log", "--format=%s", "-3"])).toMatch(/howto\/queued-two/);
      expect(sh(m.a, "git", ["log", "--format=%s", "-3"])).toMatch(/howto\/queued\b/);
      expect(existsSync(writeLockPath(cfg))).toBe(false);
    } finally { release(); } // a failed assertion must not leave the lock for the next test
  }, 60_000);

  it("the wait still gives up with a clear error after the configured timeout", async () => {
    const short = await startHttpServer(cfg, { port: 0, host: "127.0.0.1", token: TOKEN, flushIntervalMs: 60_000, lockTimeoutMs: 300 });
    const release = holdLock();
    try {
      const t0 = Date.now();
      const r = await fetch(`http://127.0.0.1:${short.port}/${TOKEN}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "wiki_upsert", arguments: { id: "howto/never", title: "Never", summary: "Blocked behind a writer that never finishes.", tags: ["wiki"], body, force: true } } }) }).then((x) => x.text());
      expect(r).toContain("another doltap write is in progress");
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally { release(); await short.close(); }
  }, 20_000);
});
