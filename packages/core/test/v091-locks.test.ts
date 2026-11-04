import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  WikiDb, audit, listConflictFiles, publishHostStats, readPage, readSyncState, refreshHubs, resolveConfig, search, syncAll, upsertPage, withWriteLockAsync, writeAuditReport, writeLockPath, writeSyncState,
  type WikiConfig,
} from "../src/index.js";
import { makeTwoMachines, sh } from "./helpers.js";

/**
 * 0.9.1 core audit M2, M8, M9, L3, L9, L12, L13: every git-touching path takes the machine write lock (auto-pull
 * skips when busy), hub and report conflicts never leave copies, a page vanishing mid-reindex is not an error,
 * async waiters honour their timeout, sync.json is written atomically, FTS rows are addressed by rowid.
 */
const howto = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";

let m: ReturnType<typeof makeTwoMachines>;
let A: WikiConfig;
let B: WikiConfig;
let child: ChildProcess | null = null;
beforeEach(() => {
  m = makeTwoMachines();
  A = { ...resolveConfig({ root: m.a, agent: "test-a", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
  B = { ...resolveConfig({ root: m.b, agent: "test-b", session: "sess-b" }), hostname: "machine-b", autoPullMinutes: 0 };
});
afterEach(() => { child?.kill(); child = null; m.cleanup(); });

/** A live process from another pid holds A's write lock until released. */
function holdForeignLock(cfg: WikiConfig): () => void {
  child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  writeFileSync(writeLockPath(cfg), `${child.pid} ${new Date().toISOString()}\n`);
  return () => { child?.kill(); child = null; try { unlinkSync(writeLockPath(cfg)); } catch { /* gone */ } };
}

describe("M2: no git operation runs outside the machine write lock", () => {
  it("a read's auto-pull is skipped while another process writes, and runs once it is free", () => {
    upsertPage(B, { id: "howto/from-b", title: "From B", summary: "From B.", tags: ["wiki"], body: howto, force: true });
    const stale = { ...A, autoPullMinutes: 1 };
    writeSyncState(stale, { lastPull: "2000-01-01T00:00:00.000Z", lastPullAttempt: "2000-01-01T00:00:00.000Z" });
    const head = sh(m.a, "git", ["rev-parse", "HEAD"]);
    const release = holdForeignLock(A);
    const r = search(stale, "from b");
    expect(sh(m.a, "git", ["rev-parse", "HEAD"])).toBe(head);
    expect(r.sync.pulled).toBe(false);
    expect(r.sync.messages.join(" ")).toMatch(/write is in progress|skipped/);
    release();
    const again = search(stale, "from b");
    expect(again.sync.pulled).toBe(true);
    expect(sh(m.a, "git", ["rev-parse", "HEAD"])).not.toBe(head);
  });

  it("publishHostStats waits for the lock instead of committing through it", () => {
    const db = new WikiDb(A);
    try {
      db.reindex();
      db.logAccess("decisions/wiki-storage-markdown-git");
      const release = holdForeignLock(A);
      const t0 = Date.now();
      expect(() => publishHostStats(A, db, { pulled: false, pushed: false, offline: false, conflicts: [], messages: [] }, 0, { timeoutMs: 300 })).toThrow(/write is in progress/);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      expect(sh(m.a, "git", ["status", "--porcelain"])).toBe("");
      release();
      expect(publishHostStats(A, db, { pulled: false, pushed: false, offline: false, conflicts: [], messages: [] }, 0)).toBe(true);
      expect(sh(m.a, "git", ["log", "-1", "--format=%B"])).toMatch(/\[session:sess-a\]/);
    } finally { db.close(); }
  });
});

describe("M8 / M9: conflicts on generated files take upstream without a copy", () => {
  it("concurrent page adds in one category leave no hub conflict copy and both pages in the list", () => {
    upsertPage({ ...A, noSync: true }, { id: "howto/from-a", title: "From A", summary: "From A.", tags: ["wiki"], body: howto, force: true });
    upsertPage(B, { id: "howto/from-b", title: "From B", summary: "From B.", tags: ["wiki"], body: howto, force: true });
    const report = syncAll(A);
    expect(report.conflicts).toEqual([]);
    expect(listConflictFiles(A)).toEqual([]);
    expect(existsSync(join(m.a, "wiki", "howto", "_index.conflict-machine-a.md"))).toBe(false);
    refreshHubs(A, report);
    const hub = readPage(A, "howto/_index")!.body;
    expect(hub).toContain("[[howto/from-a]]");
    expect(hub).toContain("[[howto/from-b]]");
    expect(readPage(B, "howto/from-a")).toBeNull();
    syncAll(B);
    expect(readPage(B, "howto/from-a")).not.toBeNull();
  });

  it("two hosts writing the audit report on the same day: upstream wins, no copy, nothing to resolve", () => {
    writeAuditReport(B, audit(B));
    writeAuditReport({ ...A, noSync: true }, audit(A));
    const report = syncAll(A);
    expect(report.conflicts).toEqual([]);
    expect(listConflictFiles(A)).toEqual([]);
    const reports = readdirSync(join(m.a, "wiki", "_meta", "reports"));
    expect(reports.filter((f) => f.includes("conflict"))).toEqual([]);
    expect(reports).toHaveLength(1);
  });
});

describe("L3: a page that vanishes between the directory walk and its stat", () => {
  it("is dropped from the index instead of throwing", () => {
    const db = new WikiDb(A);
    try {
      db.reindex();
      const real = db.listFiles.bind(db);
      db.listFiles = () => [...real(), join(A.wikiDir, "howto", "ghost.md")];
      const r = db.reindex();
      expect(r.total).toBe(real().length);
      expect(db.getRow("howto/ghost")).toBeFalsy();
    } finally { db.close(); }
  });
});

describe("L9: async lock waiters honour their timeout", () => {
  it("a waiter queued behind a long in-process writer gives up at its deadline and never runs", async () => {
    const ran: string[] = [];
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const first = withWriteLockAsync(A, () => { Atomics.wait(sleeper, 0, 0, 400); ran.push("first"); return 1; });
    const second = withWriteLockAsync(A, () => { ran.push("second"); return 2; }, { timeoutMs: 100 });
    await expect(second).rejects.toThrow(/write is in progress/);
    expect(await first).toBe(1);
    expect(ran).toEqual(["first"]);
    expect(existsSync(writeLockPath(A))).toBe(false);
    expect(await withWriteLockAsync(A, () => 3)).toBe(3);
  });
});

describe("L12 / L13: state file and index housekeeping", () => {
  it("sync.json is replaced atomically (no temp file left, patch merged)", () => {
    writeSyncState(A, { pendingPush: true });
    writeSyncState(A, { lastPullAttempt: "2026-01-01T00:00:00.000Z" });
    expect(readSyncState(A)).toMatchObject({ pendingPush: true, lastPullAttempt: "2026-01-01T00:00:00.000Z" });
    expect(readdirSync(A.stateDir).filter((f) => f.startsWith("sync.json") && f !== "sync.json")).toEqual([]);
  });

  it("re-indexing a page keeps exactly one FTS row, addressed by the page's rowid", () => {
    const db = new WikiDb(A);
    try {
      db.reindex(true);
      db.reindex(true);
      const rows = db.db.prepare("SELECT count(*) AS n FROM pages_fts WHERE id = ?").get("decisions/wiki-storage-markdown-git") as { n: number };
      expect(rows.n).toBe(1);
      const same = db.db.prepare("SELECT count(*) AS n FROM pages p JOIN pages_fts f ON f.rowid = p.rowid AND f.id = p.id").get() as { n: number };
      const total = db.db.prepare("SELECT count(*) AS n FROM pages").get() as { n: number };
      expect(same.n).toBe(total.n);
      expect((db.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBeGreaterThanOrEqual(15000);
    } finally { db.close(); }
  });
});
