import { closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { WikiConfig } from "./config.js";

export interface LockOptions {
  /** How long to wait for another writer before giving up. */
  timeoutMs?: number;
  /** How long a lock file that has no pid yet (between open and write) counts as held. Default 2 s. */
  staleMs?: number;
}

const held = new Set<string>();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/** Whether the pid recorded in the lock file still runs (EPERM counts as alive: it exists but is not ours). pid 1 is never a doltap writer. */
function ownerAlive(content: string): boolean {
  const pid = Number(content.split(/\s/)[0]);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function writeLockPath(cfg: WikiConfig): string {
  return join(cfg.stateDir, "write.lock");
}

/**
 * Run `fn` while holding this machine's wiki write lock (an O_EXCL file in .doltap/). Writers from other
 * processes (CLI, MCP server, scheduler) on the same clone wait for each other instead of interleaving
 * their git commits and hub edits. Re-entrant within one process.
 */
/**
 * One attempt to take the lock file. Returns true when taken, false when another live writer holds it.
 * A lock whose recorded owner is dead is stale at once, however fresh the file (a crashed writer must not
 * cost two minutes of refused writes); a live owner keeps it however old (a long push). A file with no pid
 * yet counts as held for staleMs. A symlink in the lock's place (a collaborator can push one) is replaced.
 */
function tryAcquire(path: string, staleMs: number): boolean {
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const st = lstatSync(path);
        if (st.isSymbolicLink()) { unlinkSync(path); continue; }
        const content = readFileSync(path, "utf8");
        if (!content.trim()) {
          if (Date.now() - st.mtimeMs <= staleMs) return false;
          unlinkSync(path);
          continue;
        }
        if (!ownerAlive(content)) { unlinkSync(path); continue; }
      } catch {
        continue; // vanished between open and stat: retry immediately
      }
      return false;
    }
  }
}

const EMPTY_LOCK_GRACE_MS = 2000;

const timeoutError = (path: string) => new Error(`another doltap write is in progress (lock ${path}); retry in a moment`);

function releaseFile(path: string): void {
  held.delete(path);
  if (existsSync(path)) { try { unlinkSync(path); } catch { /* already gone */ } }
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
  const staleMs = o.staleMs ?? EMPTY_LOCK_GRACE_MS;
  const deadline = Date.now() + timeoutMs;
  while (!tryAcquire(path, staleMs)) {
    if (Date.now() >= deadline) throw timeoutError(path);
    sleep(50);
  }
  held.add(path);
  try {
    return fn();
  } finally {
    releaseFile(path);
  }
}

/** Tail of the in-process queue per lock path: async callers take turns instead of re-entering each other. */
const queues = new Map<string, Promise<void>>();

/**
 * Same lock, but the wait for another writer yields to the event loop (setTimeout instead of Atomics.wait),
 * so a server can keep answering reads while a write is queued. `fn` itself still runs synchronously
 * under the lock; nested synchronous withWriteLock calls inside it re-enter. Async callers in one process
 * are queued in arrival order, which the sync variant gets for free from the single thread.
 */
export async function withWriteLockAsync<T>(cfg: WikiConfig, fn: () => T, o: LockOptions = {}): Promise<T> {
  const path = writeLockPath(cfg);
  const timeoutMs = o.timeoutMs ?? 30_000;
  const staleMs = o.staleMs ?? EMPTY_LOCK_GRACE_MS;
  const deadline = Date.now() + timeoutMs;
  const prev = queues.get(path) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => { done = r; });
  const tail = prev.then(() => mine);
  queues.set(path, tail);
  try {
    await prev;
    if (held.has(path)) return fn(); // re-entered from inside a holder (sync-nested path keeps held set)
    while (!tryAcquire(path, staleMs)) {
      if (Date.now() >= deadline) throw timeoutError(path);
      await new Promise((r) => setTimeout(r, 50));
    }
    held.add(path);
    try {
      return fn();
    } finally {
      releaseFile(path);
    }
  } finally {
    done();
    if (queues.get(path) === tail) queues.delete(path);
  }
}
