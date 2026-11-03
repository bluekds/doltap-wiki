import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolveConfig, withWriteLock, withWriteLockAsync, writeLockPath, type WikiConfig } from "../src/index.js";
import { makeWikiCopy, type Fixture } from "./helpers.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("withWriteLockAsync (0.8)", () => {
  let fx: Fixture;
  let cfg: WikiConfig;
  beforeEach(() => { fx = makeWikiCopy(); cfg = resolveConfig({ root: fx.dir, noSync: true, agent: "t" }); });
  afterEach(() => fx.cleanup());

  it("async callers in one process take turns in arrival order and never overlap", async () => {
    const log: string[] = [];
    let inside = 0;
    const job = (name: string) => withWriteLockAsync(cfg, () => { expect(inside).toBe(0); inside++; log.push(`${name}:start`); inside--; log.push(`${name}:end`); return name; });
    const results = await Promise.all([job("a"), job("b"), job("c")]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
    expect(existsSync(writeLockPath(cfg))).toBe(false);
  });

  it("a sync withWriteLock inside the protected function re-enters instead of deadlocking", async () => {
    const r = await withWriteLockAsync(cfg, () => withWriteLock(cfg, () => withWriteLock(cfg, () => "nested")));
    expect(r).toBe("nested");
    expect(existsSync(writeLockPath(cfg))).toBe(false);
  });

  it("a throwing function releases the lock and the queue moves on", async () => {
    await expect(withWriteLockAsync(cfg, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(writeLockPath(cfg))).toBe(false);
    await tick();
    expect(await withWriteLockAsync(cfg, () => "after")).toBe("after");
  });

  it("times out with the same message as the sync variant when a live foreign writer holds the file", async () => {
    const { closeSync, openSync, unlinkSync, writeSync } = await import("node:fs");
    const p = writeLockPath(cfg);
    const fd = openSync(p, "wx"); writeSync(fd, `${process.pid} now\n`); closeSync(fd);
    try {
      await expect(withWriteLockAsync(cfg, () => 1, { timeoutMs: 200 })).rejects.toThrow(/another doltap write is in progress/);
      expect(() => withWriteLock(cfg, () => 1, { timeoutMs: 200 })).toThrow(/another doltap write is in progress/);
    } finally { unlinkSync(p); }
  });
});
