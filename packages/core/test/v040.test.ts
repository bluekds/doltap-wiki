import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cfgFor, makeTwoMachines, sh } from "./helpers.js";
import { readSyncState, remoteBackoffMinutes, syncAll, upsertPage, WikiDb, writeSyncState, type WikiConfig } from "../src/index.js";

const win = process.platform === "win32";
let m: ReturnType<typeof makeTwoMachines>;
let A: WikiConfig;
beforeEach(() => { m = makeTwoMachines(); A = cfgFor(m.a, { noSync: false, remoteTimeoutMs: 700 }); const db = new WikiDb(A); db.reindex(); db.close(); });
afterEach(() => m.cleanup());

const howto = (x: string) => `## Prerequisites\n\n${x}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;

describe("write latency with an unreachable remote (0.4)", () => {
  it.skipIf(win)("the first write pays one timeout, later writes skip the remote, sync retries and clears the backoff", () => {
    const prev = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "sh -c 'sleep 30' --";
    sh(m.a, "git", ["remote", "set-url", "origin", "ssh://example.invalid/x.git"]);
    try {
      let t = Date.now();
      const r1 = upsertPage(A, { id: "howto/off-1", title: "O1", summary: "Offline one.", tags: ["wiki"], body: howto("a"), force: true });
      const first = Date.now() - t;
      expect(r1.sync.offline).toBe(true);
      expect(r1.sync.pushed).toBe(false);
      expect(first).toBeGreaterThanOrEqual(600);
      expect(first).toBeLessThan(5000);
      expect(readSyncState(A).lastOffline).toBeTruthy();
      expect(remoteBackoffMinutes(A)).not.toBeNull();

      t = Date.now();
      const r2 = upsertPage(A, { id: "howto/off-2", title: "O2", summary: "Offline two.", tags: ["wiki"], body: howto("b"), force: true });
      const second = Date.now() - t;
      expect(r2.sync.offline).toBe(true);
      expect(r2.sync.messages.join(" ")).toMatch(/push deferred/);
      expect(second).toBeLessThan(600);
      expect(readSyncState(A).pendingPush).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = prev;
    }
    sh(m.a, "git", ["remote", "set-url", "origin", m.bare]);
    const s = syncAll(A);
    expect(s.pushed).toBe(true);
    expect(s.offline).toBe(false);
    expect(readSyncState(A).lastOffline).toBeNull();
    expect(remoteBackoffMinutes(A)).toBeNull();
    expect(sh(m.bare, "git", ["log", "--format=%s", "main"])).toContain("wiki: add howto/off-2");
    const r3 = upsertPage(A, { id: "howto/off-3", title: "O3", summary: "Back online.", tags: ["wiki"], body: howto("c"), force: true });
    expect(r3.sync.pushed).toBe(true);
  });

  it("a backoff older than autoPullMinutes no longer defers", () => {
    const B = { ...A, autoPullMinutes: 1 };
    writeSyncState(B, { lastOffline: new Date(Date.now() - 2 * 60_000).toISOString() });
    expect(remoteBackoffMinutes(B)).toBeNull();
  });
});
