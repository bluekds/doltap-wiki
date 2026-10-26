import { closeSync, existsSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { WikiConfig } from "./config.js";

export interface LockOptions {
  /** How long to wait for another writer before giving up. */
  timeoutMs?: number;
  /** A lock file older than this is treated as left behind by a crashed process and removed. */
  staleMs?: number;
}

const held = new Set<string>();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function writeLockPath(cfg: WikiConfig): string {
  return join(cfg.stateDir, "write.lock");
}

/**
 * Run `fn` while holding this machine's wiki write lock (an O_EXCL file in .doltap/). Writers from other
 * processes (CLI, MCP server, scheduler) on the same clone wait for each other instead of interleaving
 * their git commits and hub edits. Re-entrant within one process.
 */
export function withWriteLock<T>(cfg: WikiConfig, fn: () => T, o: LockOptions = {}): T {
  const path = writeLockPath(cfg);
  if (held.has(path)) return fn();
  const timeoutMs = o.timeoutMs ?? 30_000;
  const staleMs = o.staleMs ?? 2 * 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          unlinkSync(path);
          continue;
        }
      } catch {
        continue; // vanished between open and stat: retry immediately
      }
      if (Date.now() >= deadline) throw new Error(`another doltap write is in progress (lock ${path}); retry in a moment`);
      sleep(50);
    }
  }
  held.add(path);
  try {
    return fn();
  } finally {
    held.delete(path);
    if (existsSync(path)) { try { unlinkSync(path); } catch { /* already gone */ } }
  }
}
