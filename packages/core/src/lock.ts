import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
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
const lockLine = () => `${process.pid} ${new Date().toISOString()}\n`;

/**
 * Replace a lock we judged stale (its content was `expected`) with our own, without a moment where the path
 * is absent: write our line to a sibling temp file and rename it over the lock, then read back. If the lock
 * changed hands since we judged it, or the read-back shows another pid (two waiters renamed, the later one
 * owns the file), we did not get it and go on waiting. Unlink-and-recreate let the second waiter's unlink
 * remove the first waiter's fresh lock, and both believed they held it.
 */
export function takeOverStaleLock(path: string, expected: string): boolean {
  let now: string;
  try { now = readFileSync(path, "utf8"); } catch { return false; } // gone: the normal O_EXCL create will try next
  if (now !== expected) return false;
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const mine = lockLine();
  try {
    const fd = openSync(tmp, "wx");
    writeSync(fd, mine);
    closeSync(fd);
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
  try { return readFileSync(path, "utf8") === mine; } catch { return false; }
}

function tryAcquire(path: string, staleMs: number): boolean {
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, lockLine());
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let content: string;
      try {
        const st = lstatSync(path);
        if (st.isSymbolicLink()) { unlinkSync(path); continue; }
        content = readFileSync(path, "utf8");
        if (!content.trim()) {
          if (Date.now() - st.mtimeMs <= staleMs) return false;
        } else if (ownerAlive(content)) {
          return false;
        }
      } catch {
        continue; // vanished between open and stat: retry immediately
      }
      // Stale (empty past its grace, or a dead owner): take it over in place rather than unlink and recreate.
      if (takeOverStaleLock(path, content)) return true;
      sleep(5);
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

/**
 * Run `fn` under the lock only if nobody holds it right now; otherwise do nothing. For work that is
 * optional at this moment (a read's auto-pull): a reader must never rebase the tree under a writer, and
 * must not wait for one either.
 */
export function withWriteLockIfFree<T>(cfg: WikiConfig, fn: () => T, o: LockOptions = {}): { ran: true; result: T } | { ran: false } {
  const path = writeLockPath(cfg);
  if (held.has(path)) return { ran: true, result: fn() };
  if (!tryAcquire(path, o.staleMs ?? EMPTY_LOCK_GRACE_MS)) return { ran: false };
  held.add(path);
  try {
    return { ran: true, result: fn() };
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
    // The queue ahead may have taken longer than this caller's budget (a long synchronous writer blocks the
    // loop, so the timer could not fire meanwhile): give up now rather than run a write the client abandoned.
    if (Date.now() >= deadline) throw timeoutError(path);
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
