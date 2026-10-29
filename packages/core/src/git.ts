import { execFile, execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { WikiConfig } from "./config.js";
import { withWriteLock } from "./lock.js";

/** Mask `user:password@` in URLs so git errors can be shown to callers (remote URLs may embed credentials). */
export function redactCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1***@");
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface SyncReport {
  pulled: boolean;
  pushed: boolean;
  /** The remote could not be reached (DNS, connection, timeout). The commit is kept locally and pushed later. */
  offline: boolean;
  /** The remote answered but refused: authentication, permissions, wrong URL, missing repository. Needs a human. */
  remoteError?: string;
  conflicts: string[];
  messages: string[];
}

export function git(cfg: WikiConfig, args: string[], opts: { timeoutMs?: number; allowFail?: boolean } = {}): GitResult {
  const o: ExecFileSyncOptions = {
    cwd: cfg.root,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30000,
    stdio: ["ignore", "pipe", "pipe"],
    // GIT_EDITOR=: works through git's bundled sh on every platform including Git for Windows.
    env: { ...process.env, GIT_EDITOR: ":", GIT_TERMINAL_PROMPT: "0" },
  };
  try {
    const stdout = execFileSync("git", args, o) as string;
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (e) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; message: string; killed?: boolean; signal?: string | null; code?: string };
    let stderr = String(err.stderr ?? err.message).trim();
    // A child killed by the timeout has empty stderr; name the cause so the remote failure is classified as offline.
    if (err.killed || err.signal || err.code === "ETIMEDOUT") stderr = `timed out after ${o.timeout}ms: git ${args.join(" ")}${stderr ? `\n${stderr}` : ""}`;
    const res = { ok: false, stdout: String(err.stdout ?? "").trim(), stderr };
    if (opts.allowFail) return res;
    throw new Error(redactCredentials(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`));
  }
}

export function isRepo(cfg: WikiConfig): boolean {
  return existsSync(join(cfg.root, ".git"));
}

export function hasRemote(cfg: WikiConfig): boolean {
  return git(cfg, ["remote"], { allowFail: true }).stdout.length > 0;
}

export function isDirty(cfg: WikiConfig, pathspec = "wiki"): boolean {
  return git(cfg, ["status", "--porcelain", "--", pathspec]).stdout.length > 0;
}

export interface SyncState {
  /** Last successful pull. */
  lastPull?: string;
  /** Last pull attempt, successful or not; auto-pull backs off from this so a dead remote is not retried on every read. */
  lastPullAttempt?: string;
  pendingPush?: boolean;
  /** When the remote was last found unreachable; writes skip the remote for cfg.autoPullMinutes after it. Cleared by any successful pull or push. */
  lastOffline?: string | null;
}

function statePath(cfg: WikiConfig): string {
  return join(cfg.stateDir, "sync.json");
}

export function readSyncState(cfg: WikiConfig): SyncState {
  try {
    return JSON.parse(readFileSync(statePath(cfg), "utf8")) as SyncState;
  } catch {
    return {};
  }
}

export function writeSyncState(cfg: WikiConfig, patch: SyncState): void {
  writeFileSync(statePath(cfg), JSON.stringify({ ...readSyncState(cfg), ...patch }, null, 2));
}

/** Authentication, permission and URL problems: retrying will not help, a human must fix the remote or the credentials. */
function remoteErrorOf(stderr: string): string | null {
  const m = /permission denied|authentication failed|could not read username|invalid username or password|the requested url returned error: 40[134]|repository not found|does not appear to be a git repository|does not exist|repository '.*' not found|\[remote rejected\]|hook declined|protected branch|not allowed to push|insufficient permission|unpacker error|push declined|GH0\d\d/i.exec(stderr);
  if (!m) return null;
  const line = stderr.split("\n").find((l) => l.toLowerCase().includes(m[0].toLowerCase())) ?? m[0];
  return redactCredentials(line.replace(/^fatal:\s*/i, "").trim());
}

/** Network-level failures only; auth and URL errors are classified by remoteErrorOf first. */
function looksOffline(stderr: string): boolean {
  return /could not resolve|unable to access|connection|network|timed out|no route to host|Could not read from remote/i.test(stderr);
}

/** Classify a failed pull/push into the report. Returns true when it was handled (offline or remote error). */
function reportRemoteFailure(cfg: WikiConfig, report: SyncReport, verb: string, stderr: string): boolean {
  const err = remoteErrorOf(stderr);
  if (err) {
    report.remoteError = err;
    report.messages.push(`remote error: ${err} (${verb} skipped, commit saved locally)`);
    return true;
  }
  if (looksOffline(stderr)) {
    report.offline = true;
    report.messages.push(`${verb} skipped: remote unreachable (commit saved locally)`);
    writeSyncState(cfg, { lastOffline: new Date().toISOString() });
    return true;
  }
  return false;
}

/**
 * Minutes since the remote was last found unreachable, when that is more recent than cfg.autoPullMinutes.
 * Writes use it to skip the remote outright: one timeout per interval, not one per write.
 */
export function remoteBackoffMinutes(cfg: WikiConfig): number | null {
  const iso = readSyncState(cfg).lastOffline;
  if (!iso) return null;
  const min = (Date.now() - Date.parse(iso)) / 60000;
  return Number.isFinite(min) && min >= 0 && min < cfg.autoPullMinutes ? min : null;
}

function deferForBackoff(cfg: WikiConfig, report: SyncReport, verb: string): boolean {
  const min = remoteBackoffMinutes(cfg);
  if (min === null) return false;
  report.offline = true;
  report.messages.push(`${verb} deferred: remote was unreachable ${Math.round(min)} min ago; the next sync retries (commit saved locally)`);
  return true;
}

/** Writes need a branch to commit on; a detached HEAD would orphan the commit while the report says it was saved. */
export function assertOnBranch(cfg: WikiConfig): void {
  if (!isRepo(cfg)) return;
  if (!git(cfg, ["symbolic-ref", "-q", "HEAD"], { allowFail: true }).ok) throw new Error("repository is on a detached HEAD; check out a branch (git checkout main) before writing");
}

/**
 * Keep the upstream version (index stage 2) of one conflicted path. For wiki pages the local version
 * (stage 3) is preserved next to it as `<name>.conflict-<host>.md`; for anything else (lockfiles, build
 * config) the local change is discarded, since only wiki/ is meant to be edited on client machines.
 * Stage numbers are the same for a rebase stop and for a failed autostash pop.
 */
function resolveOneConflict(cfg: WikiConfig, file: string, saved: string[]): void {
  const upstream = git(cfg, ["show", `:2:${file}`], { allowFail: true });
  const local = git(cfg, ["show", `:3:${file}`], { allowFail: true });
  const isPage = file.startsWith("wiki/") && file.endsWith(".md") && !file.startsWith("wiki/.obsidian/");
  const conflictName = file.replace(/\.md$/, "") + `.conflict-${cfg.hostname}.md`;
  if (isPage && local.ok) writeFileSync(join(cfg.root, conflictName), local.stdout + "\n");
  if (upstream.ok) writeFileSync(join(cfg.root, file), upstream.stdout + "\n");
  else git(cfg, ["rm", "-q", "--", file], { allowFail: true });
  git(cfg, ["add", "--", file, ...(isPage && local.ok ? [conflictName] : [])], { allowFail: true });
  if (isPage && local.ok) saved.push(conflictName);
}

/** After `pull --autostash` fails to re-apply the stash, resolve the unmerged paths and drop the stash. */
function resolveAutostashConflicts(cfg: WikiConfig): string[] {
  const saved: string[] = [];
  const conflicted = git(cfg, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).stdout.split("\n").filter(Boolean);
  for (const file of conflicted) resolveOneConflict(cfg, file, saved);
  // The resolved files are now staged; unstage so they stay plain working-tree edits (pages) or clean (others).
  git(cfg, ["reset", "-q"], { allowFail: true });
  const stashes = git(cfg, ["stash", "list"], { allowFail: true }).stdout;
  if (/autostash/i.test(stashes)) git(cfg, ["stash", "drop", "-q"], { allowFail: true });
  return saved;
}

/**
 * Resolve a rebase stopped on conflicts by keeping the upstream version of each conflicted file and
 * saving the replayed (local) version next to it as `<name>.conflict-<host>.md`.
 */
function resolveRebaseConflicts(cfg: WikiConfig): string[] {
  const saved: string[] = [];
  for (let guard = 0; guard < 20; guard++) {
    const conflicted = git(cfg, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).stdout.split("\n").filter(Boolean);
    if (!conflicted.length) {
      const st = git(cfg, ["status", "--porcelain"], { allowFail: true }).stdout;
      if (!existsSync(join(cfg.root, ".git", "rebase-merge")) && !existsSync(join(cfg.root, ".git", "rebase-apply"))) break;
      if (!st) break;
    }
    for (const file of conflicted) resolveOneConflict(cfg, file, saved);
    const cont = git(cfg, ["rebase", "--continue"], { allowFail: true });
    if (cont.ok) break;
    if (/no rebase in progress/i.test(cont.stderr)) break;
    if (!/conflict/i.test(cont.stderr + cont.stdout) && !git(cfg, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).stdout) {
      // Empty commit after taking upstream: skip it.
      git(cfg, ["rebase", "--skip"], { allowFail: true });
    }
  }
  return saved;
}

/** git pull --rebase --autostash. Returns a report; never throws on network failure. */
export function pull(cfg: WikiConfig, report: SyncReport = emptyReport(), o: { force?: boolean } = {}): SyncReport {
  if (cfg.noSync || !isRepo(cfg) || !hasRemote(cfg)) return report;
  if (!o.force && deferForBackoff(cfg, report, "pull")) return report;
  writeSyncState(cfg, { lastPullAttempt: new Date().toISOString() });
  const res = git(cfg, ["pull", "--rebase", "--autostash", "--quiet"], { allowFail: true, timeoutMs: cfg.remoteTimeoutMs });
  // A failed autostash re-apply exits 0 and only prints to stderr, so look at the index instead.
  const unmerged = git(cfg, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).stdout.split("\n").filter(Boolean);
  const stashLeft = /autostash/i.test(git(cfg, ["stash", "list"], { allowFail: true }).stdout);
  if (res.ok || (unmerged.length && stashLeft)) {
    if (unmerged.length) {
      const saved = resolveAutostashConflicts(cfg);
      report.conflicts.push(...saved);
      report.messages.push(`autostash conflicted; upstream kept${saved.length ? `, local pages saved as: ${saved.join(", ")}` : ""}`);
    }
    report.pulled = true;
    writeSyncState(cfg, { lastPull: new Date().toISOString(), lastOffline: null });
    return report;
  }
  if (reportRemoteFailure(cfg, report, "pull", res.stderr)) return report;
  const output = res.stderr + res.stdout;
  if (/conflict/i.test(output)) {
    const saved = resolveRebaseConflicts(cfg);
    report.conflicts.push(...saved);
    report.pulled = true;
    report.messages.push(`pull had conflicts; local versions saved as: ${saved.join(", ") || "(none)"}`);
    writeSyncState(cfg, { lastPull: new Date().toISOString() });
    return report;
  }
  report.messages.push(redactCredentials(`pull failed: ${res.stderr}`));
  return report;
}

export function emptyReport(): SyncReport {
  return { pulled: false, pushed: false, offline: false, conflicts: [], messages: [] };
}

/** Trailer values come from config, env and the HTTP clients file; keep them to one token so nobody can forge a second trailer. */
export function trailerValue(s: string): string {
  return s.replace(/[\s\[\]]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function commitMessage(cfg: WikiConfig, action: string, id: string, extra?: string): string {
  const tags = [`[host:${trailerValue(cfg.hostname)}]`, `[agent:${trailerValue(cfg.agent)}]`];
  if (cfg.session) tags.push(`[session:${trailerValue(cfg.session)}]`);
  return `wiki: ${action} ${id}\n\n${tags.join(" ")}${extra ? "\n\n" + extra : ""}`;
}

/** Stage the given paths (relative to root), commit, then push with rebase-retry. */
export function commitAndPush(cfg: WikiConfig, paths: string[], message: string, report: SyncReport = emptyReport()): SyncReport {
  if (!isRepo(cfg)) return report;
  // git pathspecs are always forward-slash, even on Windows.
  git(cfg, ["add", "--", ...paths.map((p) => p.split(sep).join("/"))]);
  const staged = git(cfg, ["diff", "--cached", "--name-only"], { allowFail: true }).stdout;
  if (!staged) {
    report.messages.push("nothing to commit");
    return report;
  }
  git(cfg, ["commit", "--quiet", "-m", message]);
  if (cfg.noSync || !hasRemote(cfg)) return report;
  if (cfg.deferPush) {
    writeSyncState(cfg, { pendingPush: true });
    report.messages.push("push deferred to the background flusher");
    return report;
  }
  if (deferForBackoff(cfg, report, "push")) {
    writeSyncState(cfg, { pendingPush: true });
    return report;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = git(cfg, ["push", "--quiet"], { allowFail: true, timeoutMs: cfg.remoteTimeoutMs });
    if (res.ok) {
      report.pushed = true;
      writeSyncState(cfg, { pendingPush: false, lastOffline: null });
      return report;
    }
    if (reportRemoteFailure(cfg, report, "push", res.stderr)) {
      writeSyncState(cfg, { pendingPush: true });
      return report;
    }
    pull(cfg, report);
  }
  report.messages.push("push failed after 3 attempts (commit saved locally)");
  writeSyncState(cfg, { pendingPush: true });
  return report;
}

/** Push anything left over from an earlier offline write. */
export function pushPending(cfg: WikiConfig, report: SyncReport = emptyReport()): SyncReport {
  if (cfg.noSync || !isRepo(cfg) || !hasRemote(cfg)) return report;
  const ahead = git(cfg, ["rev-list", "--count", "@{u}..HEAD"], { allowFail: true });
  if (!ahead.ok || ahead.stdout === "0") return report;
  const res = git(cfg, ["push", "--quiet"], { allowFail: true, timeoutMs: cfg.remoteTimeoutMs });
  if (res.ok) {
    report.pushed = true;
    writeSyncState(cfg, { pendingPush: false, lastOffline: null });
  } else if (!reportRemoteFailure(cfg, report, "push", res.stderr)) report.messages.push(redactCredentials(`push failed: ${res.stderr}`));
  return report;
}

/**
 * Background push for a long-running process (the HTTP server): `git push` runs as a child process without
 * blocking the event loop, so requests keep being served. No wiki write lock is taken: a commit made during
 * the push simply stays pending and the next call pushes it. A rejected push (someone else pushed first)
 * pulls under the lock, then pushes once more.
 */
export async function pushPendingAsync(cfg: WikiConfig): Promise<SyncReport> {
  const report = emptyReport();
  if (cfg.noSync || !isRepo(cfg) || !hasRemote(cfg)) return report;
  const ahead = git(cfg, ["rev-list", "--count", "@{u}..HEAD"], { allowFail: true });
  if (!ahead.ok || ahead.stdout === "0") {
    if (readSyncState(cfg).pendingPush) writeSyncState(cfg, { pendingPush: false });
    return report;
  }
  if (deferForBackoff(cfg, report, "push")) return report;
  const run = () =>
    new Promise<GitResult>((resolve) => {
      execFile("git", ["push", "--quiet"], { cwd: cfg.root, encoding: "utf8", timeout: cfg.remoteTimeoutMs, env: { ...process.env, GIT_EDITOR: ":", GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? "").trim() || (err ? String(err.message) : "") }),
      );
    });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await run();
    if (res.ok) {
      report.pushed = true;
      // A commit made while the push ran is still ahead: leave it pending for the next pass.
      const left = git(cfg, ["rev-list", "--count", "@{u}..HEAD"], { allowFail: true });
      writeSyncState(cfg, { pendingPush: left.ok && left.stdout !== "0", lastOffline: null });
      return report;
    }
    if (reportRemoteFailure(cfg, report, "push", res.stderr)) return report;
    report.messages.push(redactCredentials(`push rejected, pulling first: ${res.stderr.split("\n").find((l) => /rejected|fetch first|non-fast-forward/i.test(l)) ?? res.stderr.slice(0, 120)}`));
    if (attempt === 0) withWriteLock(cfg, () => pull(cfg, report, { force: true }));
  }
  report.messages.push("push failed after a pull (commit kept locally; the scheduler retries)");
  return report;
}

/** Full sync: pull (resolving conflicts) then push anything pending. Always tries the remote, even during a backoff. */
export function syncAll(cfg: WikiConfig): SyncReport {
  return withWriteLock(cfg, () => {
    const report = emptyReport();
    pull(cfg, report, { force: true });
    pushPending(cfg, report);
    return report;
  });
}

/** Pull if the last pull is older than cfg.autoPullMinutes. Cheap no-op otherwise. */
export function maybeAutoPull(cfg: WikiConfig): SyncReport {
  const report = emptyReport();
  if (cfg.noSync || cfg.autoPullMinutes <= 0) return report;
  const st = readSyncState(cfg);
  const ageMin = (iso?: string) => (iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity);
  // Back off from the last attempt, not only the last success: a hanging or dead remote costs one timeout per interval, not one per read.
  if (ageMin(st.lastPull) < cfg.autoPullMinutes || ageMin(st.lastPullAttempt) < cfg.autoPullMinutes) return report;
  return pull(cfg, report);
}

/** Conflict files currently present in the working tree. */
export function listConflictFiles(cfg: WikiConfig): string[] {
  const out = git(cfg, ["ls-files", "--", "wiki"], { allowFail: true }).stdout.split("\n");
  const untracked = git(cfg, ["ls-files", "--others", "--exclude-standard", "--", "wiki"], { allowFail: true }).stdout.split("\n");
  return [...out, ...untracked].filter((f) => /\.conflict-[^./]+\.md$/.test(f));
}
