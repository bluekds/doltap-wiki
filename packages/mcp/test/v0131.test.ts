import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSyncState, resolveConfig, type WikiConfig } from "@bluekds/doltap-core";
import { makeTwoMachines, sh } from "../../core/test/helpers.js";
import { startHttpServer } from "../src/http.js";

/**
 * 0.13.1: closing the HTTP server must leave no git process behind. Before, a write scheduled a push 500 ms
 * later on a timer that close() never cleared, and close() did not wait for a push already running, so
 * `git push` could start or keep running in the wiki after close() resolved (on Windows the temp repo
 * could then not be removed: EBUSY in CI).
 */
const TOKEN = "ab".repeat(32);
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let m: ReturnType<typeof makeTwoMachines>;
let cfg: WikiConfig;
beforeEach(() => {
  m = makeTwoMachines();
  cfg = resolveConfig({ root: m.a, agent: "test", deferPush: true });
});
afterEach(() => m.cleanup());

const remoteHead = () => sh(m.a, "git", ["ls-remote", m.bare, "refs/heads/main"]).split(/\s/)[0];

async function upsert(port: number, id: string): Promise<void> {
  const r = await fetch(`http://127.0.0.1:${port}/${TOKEN}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wiki_upsert", arguments: { id, title: "Close test", summary: "Written just before the server closes.", tags: ["wiki"], body, force: true } } }),
  });
  expect(await r.text()).not.toContain("isError");
}

describe("close() leaves no push behind", () => {
  it("a push scheduled by a write does not start after close()", async () => {
    const srv = await startHttpServer(cfg, { port: 0, host: "127.0.0.1", token: TOKEN, flushIntervalMs: 60_000 });
    const before = remoteHead();
    await upsert(srv.port, "howto/close-scheduled");
    expect(readSyncState(cfg).pendingPush).toBe(true);
    await srv.close();
    await wait(900); // past the 500 ms post-write timer
    expect(remoteHead()).toBe(before);
    // Still pending: the scheduler (or the next start) pushes it.
    expect(readSyncState(cfg).pendingPush).toBe(true);
  });

  it("close() waits for a push that is already running", async () => {
    const srv = await startHttpServer(cfg, { port: 0, host: "127.0.0.1", token: TOKEN, flushIntervalMs: 60_000 });
    const before = remoteHead();
    await upsert(srv.port, "howto/close-running");
    const running = srv.flush();
    await srv.close();
    // The push finished before close() resolved: the remote has the commit and nothing is pending.
    expect(remoteHead()).not.toBe(before);
    expect(readSyncState(cfg).pendingPush).toBe(false);
    await running;
  });

  it("flush() after close() does nothing", async () => {
    const srv = await startHttpServer(cfg, { port: 0, host: "127.0.0.1", token: TOKEN, flushIntervalMs: 60_000 });
    const before = remoteHead();
    await upsert(srv.port, "howto/close-late");
    await srv.close();
    await srv.flush();
    expect(remoteHead()).toBe(before);
  });
});
