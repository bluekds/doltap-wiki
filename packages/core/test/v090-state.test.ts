import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctor, resolveConfig, syncAll, trackedStateFiles, upsertPage, withWriteLock, writeLockPath, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, makeWikiCopy, sh, type Fixture } from "./helpers.js";

/**
 * 0.9 security audit S2 / core M11: files a collaborator commits under `.doltap/` (the gitignored state dir
 * inside the clone) arrive through `git pull` like any tracked file. They must never become this machine's
 * token, client list or lock: sync and doctor report them, and a lock whose owner is dead clears at once.
 */
const howto = (n: string) => `## Prerequisites\n\n${n}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;

describe("planted .doltap files", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  let B: WikiConfig;
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "attacker", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
    B = { ...resolveConfig({ root: m.b, agent: "victim", session: "sess-b" }), hostname: "machine-b", autoPullMinutes: 0 };
  });
  afterEach(() => m.cleanup());

  it("sync warns, doctor fails, and a planted lock never blocks a write", async () => {
    mkdirSync(join(m.a, ".doltap"), { recursive: true });
    writeFileSync(join(m.a, ".doltap", "http-clients.json"), JSON.stringify({ evil: { token: "e".repeat(64), readOnly: false, created: "2026-01-01" } }));
    writeFileSync(join(m.a, ".doltap", "write.lock"), "1 2026-01-01T00:00:00.000Z\n");
    sh(m.a, "git", ["add", "-f", ".doltap/http-clients.json", ".doltap/write.lock"]);
    sh(m.a, "git", ["commit", "-qm", "wiki: plant"]);
    sh(m.a, "git", ["push", "-q"]);
    expect(trackedStateFiles(B)).toEqual([]);
    const r = syncAll(B);
    expect(trackedStateFiles(B).sort()).toEqual([".doltap/http-clients.json", ".doltap/write.lock"]);
    expect(r.messages.join("\n")).toMatch(/\.doltap\/http-clients\.json.*tracked by git/);
    const d = await doctor(B, { services: false });
    const state = d.checks.find((c) => c.name === "state")!;
    expect(state.status).toBe("fail");
    expect(state.detail).toContain("http-clients.json");
    expect(state.fix).toContain("git rm --cached");
    // The planted lock names pid 1 with an old date: pid 1 is never a doltap writer, so the lock is stale at once.
    const t = Date.now();
    expect(withWriteLock(B, () => "ok", { timeoutMs: 2000 })).toBe("ok");
    expect(Date.now() - t).toBeLessThan(1500);
    expect(upsertPage(B, { id: "howto/after-plant", title: "After", summary: "After.", tags: ["wiki"], body: howto("a"), force: true }).refused).toBeUndefined();
  });

  it("a symlinked lock file is replaced, not followed", () => {
    const outside = join(m.b, "..", `lock-target-${process.pid}.txt`);
    writeFileSync(outside, "999999 2026-01-01T00:00:00.000Z\n");
    symlinkSync(outside, writeLockPath(B));
    expect(withWriteLock(B, () => "ok", { timeoutMs: 2000 })).toBe("ok");
    expect(readFileSync(outside, "utf8")).toBe("999999 2026-01-01T00:00:00.000Z\n");
    expect(existsSync(writeLockPath(B))).toBe(false);
  });
});

describe("lock staleness (M11)", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeWikiCopy(); });
  afterEach(() => fx.cleanup());

  it("a lock whose owner is dead clears immediately, whatever its age; a live owner keeps it", () => {
    const cfg = resolveConfig({ root: fx.dir, agent: "t", noSync: true });
    const path = writeLockPath(cfg);
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(dead.status).toBe(0);
    writeFileSync(path, `${dead.pid} ${new Date().toISOString()}\n`); // fresh mtime, dead pid
    const t = Date.now();
    expect(withWriteLock(cfg, () => 1, { timeoutMs: 3000 })).toBe(1);
    expect(Date.now() - t).toBeLessThan(1000);
    // A live owner (this process) with an ancient mtime still holds it.
    writeFileSync(path, `${process.pid} 2020-01-01T00:00:00.000Z\n`);
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(path, old, old);
    expect(() => withWriteLock(cfg, () => 1, { timeoutMs: 300 })).toThrow(/another doltap write is in progress/);
    // An empty lock (the window between open and write) is treated as live for a moment, then as dead.
    writeFileSync(path, "");
    expect(() => withWriteLock(cfg, () => 1, { timeoutMs: 300, staleMs: 10_000 })).toThrow(/in progress/);
    utimesSync(path, old, old);
    expect(withWriteLock(cfg, () => 2, { timeoutMs: 300 })).toBe(2);
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });
});
