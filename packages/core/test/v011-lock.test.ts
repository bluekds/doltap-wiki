import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { takeOverStaleLock, withWriteLock, writeLockPath, type WikiConfig } from "../src/index.js";
import { cfgFor, makeWikiCopy, type Fixture } from "./helpers.js";

/**
 * 0.11 (core audit M11, "related"): a stale lock is taken over by writing our own lock file beside it and
 * renaming it into place, then reading back. Two waiters that both judged the same lock stale can no longer
 * each unlink and recreate (the second unlink removed the first one's fresh lock: two holders); the loser of
 * the rename sees the other pid on read-back and goes on waiting.
 */
let fx: Fixture;
let cfg: WikiConfig;
beforeEach(() => { fx = makeWikiCopy(); cfg = cfgFor(fx.dir); });
afterEach(() => fx.cleanup());

const stale = "1 2026-01-01T00:00:00.000Z\n"; // pid 1 is never a doltap writer

describe("stale lock takeover", () => {
  it("replaces a dead owner's lock with ours atomically and leaves no temp file", () => {
    const path = writeLockPath(cfg);
    writeFileSync(path, stale);
    const got = withWriteLock(cfg, () => readFileSync(path, "utf8"), { timeoutMs: 2000 });
    expect(got.split(" ")[0]).toBe(String(process.pid));
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dirname(path)).filter((f) => f.startsWith("write.lock"))).toEqual([]);
  });

  it("gives up the takeover when the lock changed hands meanwhile, keeping the new owner's file", () => {
    const path = writeLockPath(cfg);
    const live = `${process.pid} 2026-11-04T00:00:00.000Z\n`;
    writeFileSync(path, live);
    // We judged `stale` earlier; by now another writer (a live pid) holds the lock: no takeover.
    expect(takeOverStaleLock(path, stale)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(live);
    expect(readdirSync(dirname(path)).filter((f) => f.startsWith("write.lock."))).toEqual([]);
    // Unchanged since we judged it: the takeover goes through and the file is ours.
    writeFileSync(path, stale);
    expect(takeOverStaleLock(path, stale)).toBe(true);
    expect(readFileSync(path, "utf8").split(" ")[0]).toBe(String(process.pid));
  });
});
