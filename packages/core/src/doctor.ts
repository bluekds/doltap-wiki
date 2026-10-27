import { existsSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import type { WikiConfig } from "./config.js";
import { WikiDb } from "./db.js";
import { git, hasRemote, isRepo, listConflictFiles, readSyncState } from "./git.js";
import { DEFAULT_LOG_MAX_BYTES, listLogs } from "./logs.js";
import { httpServiceStatus, scheduleStatus } from "./schedule.js";
import { loadTags, tagsPath } from "./tags.js";
import { lintAll } from "./write.js";

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  /** What to run or change to clear a warn/fail. */
  fix?: string;
}

export interface DoctorOptions {
  /** Probe the service manager (launchd/cron/schtasks) and the local HTTP service. Off in tests. */
  services?: boolean;
  /** A public health URL to probe as well (the `/healthz` path only; it carries no token). */
  healthzUrl?: string;
  timeoutMs?: number;
  /** Last pull older than this is a warning; default 3x the scheduled interval, or 60 min without a schedule. */
  maxPullAgeMinutes?: number;
  logMaxBytes?: number;
  /** How many recent write commits to inspect for session trailers. */
  recentCommits?: number;
  /** Checks computed by the caller (the CLI adds the agent-client integration checks). */
  extra?: DoctorCheck[];
}

export interface DoctorReport {
  root: string;
  host: string;
  checks: DoctorCheck[];
  failures: number;
  warnings: number;
  ok: boolean;
}

const CLIENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function ageMinutes(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (Date.now() - t) / 60000;
}

function fmtAge(min: number): string {
  if (min < 90) return `${Math.round(min)} min ago`;
  if (min < 48 * 60) return `${(min / 60).toFixed(1)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

async function probe(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.text()).trim();
    return res.ok && body === "ok" ? null : `HTTP ${res.status} ${body.slice(0, 60)}`;
  } catch (e) {
    return (e as Error).name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : (e as Error).message;
  }
}

function repoChecks(cfg: WikiConfig, checks: DoctorCheck[]): void {
  if (!isRepo(cfg)) {
    checks.push({ name: "repo", status: "fail", detail: `${cfg.root} is not a git repository`, fix: "git init -b main && git add -A && git commit" });
    return;
  }
  const branch = git(cfg, ["symbolic-ref", "-q", "--short", "HEAD"], { allowFail: true });
  const email = git(cfg, ["config", "user.email"], { allowFail: true }).stdout;
  if (!branch.ok) checks.push({ name: "repo", status: "fail", detail: "detached HEAD: writes would be refused", fix: "git checkout main" });
  else if (!email) checks.push({ name: "repo", status: "fail", detail: `on ${branch.stdout}, but git identity is not set: commits fail`, fix: `git -C ${cfg.root} config user.name <name> && git config user.email <email>` });
  else checks.push({ name: "repo", status: "ok", detail: `on ${branch.stdout}, identity ${email}` });

  if (!hasRemote(cfg)) {
    checks.push({ name: "remote", status: "warn", detail: "no git remote: this clone never syncs", fix: "git remote add origin <url> && git push -u origin main" });
  } else {
    const counts = git(cfg, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], { allowFail: true });
    const st = readSyncState(cfg);
    if (!counts.ok) checks.push({ name: "remote", status: "warn", detail: "no upstream branch configured", fix: "git push -u origin main" });
    else {
      const [behind, ahead] = counts.stdout.split(/\s+/).map(Number);
      if (ahead > 0 || st.pendingPush) checks.push({ name: "remote", status: "warn", detail: `${ahead} commit(s) not pushed${st.pendingPush ? " (pending push recorded)" : ""}`, fix: "doltap sync" });
      else if (behind > 0) checks.push({ name: "remote", status: "warn", detail: `${behind} fetched commit(s) not applied`, fix: "doltap sync" });
      else checks.push({ name: "remote", status: "ok", detail: "in sync with upstream (as of the last pull)" });
    }
  }

  const dirty = git(cfg, ["status", "--porcelain", "--", "wiki"], { allowFail: true }).stdout.split("\n").filter(Boolean);
  if (dirty.length) checks.push({ name: "worktree", status: "warn", detail: `${dirty.length} uncommitted change(s) under wiki/ (manual edits?)`, fix: "commit them (Obsidian git plugin or git commit) so other machines receive them" });
  else checks.push({ name: "worktree", status: "ok", detail: "wiki/ clean" });

  const conflicts = listConflictFiles(cfg);
  if (conflicts.length) checks.push({ name: "conflicts", status: "warn", detail: `${conflicts.length} conflict copy(ies): ${conflicts.slice(0, 3).join(", ")}${conflicts.length > 3 ? ", …" : ""}`, fix: "doltap resolve <id> --file <merged.md> (or --take conflict)" });
  else checks.push({ name: "conflicts", status: "ok", detail: "none" });
}

function syncAgeCheck(cfg: WikiConfig, checks: DoctorCheck[], maxAge: number, scheduled: boolean): void {
  if (cfg.noSync || !isRepo(cfg) || !hasRemote(cfg)) { checks.push({ name: "sync", status: "skip", detail: "no remote or sync disabled" }); return; }
  const st = readSyncState(cfg);
  const age = ageMinutes(st.lastPull);
  if (age === null) checks.push({ name: "sync", status: "warn", detail: "never pulled on this machine", fix: "doltap sync" });
  else if (age > maxAge) checks.push({ name: "sync", status: scheduled ? "fail" : "warn", detail: `last pull ${fmtAge(age)} (limit ${maxAge} min)${scheduled ? "; the scheduled sync is not running" : ""}`, fix: scheduled ? "doltap schedule install (re-registers the job) and check .doltap/logs/sync.err" : "doltap sync, or doltap schedule install" });
  else checks.push({ name: "sync", status: "ok", detail: `last pull ${fmtAge(age)}` });
}

function contentChecks(cfg: WikiConfig, checks: DoctorCheck[]): void {
  let raw = "";
  try {
    raw = readFileSync(tagsPath(cfg), "utf8");
    const tags = loadTags(cfg);
    if (raw.includes("\r\n")) checks.push({ name: "tags", status: "warn", detail: `${tags.length} tags; tags.yaml has CRLF line endings`, fix: "convert to LF (git add --renormalize wiki/_meta/tags.yaml with the skeleton .gitattributes)" });
    else checks.push({ name: "tags", status: "ok", detail: `${tags.length} tags parse` });
  } catch (e) {
    checks.push({ name: "tags", status: "fail", detail: `tags.yaml does not parse: ${(e as Error).message.split("\n")[0]}`, fix: "fix wiki/_meta/tags.yaml by hand; every write and lint fails until it parses" });
  }

  let issues: ReturnType<typeof lintAll>;
  try { issues = lintAll(cfg); } catch (e) {
    checks.push({ name: "lint", status: "fail", detail: `lint cannot run: ${(e as Error).message.split("\n")[0]}`, fix: "fix the tags vocabulary first" });
    return;
  }
  const errors = issues.filter((i) => i.level === "error");
  const sample = (rows: typeof issues) => rows.slice(0, 3).map((i) => `${i.id} [${i.rule}]`).join(", ") + (rows.length > 3 ? ", …" : "");
  if (errors.length) checks.push({ name: "lint", status: "fail", detail: `${errors.length} error(s), ${issues.length - errors.length} warning(s): ${sample(errors)}`, fix: "doltap lint, then fix the pages listed" });
  else if (issues.length) checks.push({ name: "lint", status: "warn", detail: `${issues.length} warning(s): ${sample(issues)}`, fix: "doltap lint" });
  else checks.push({ name: "lint", status: "ok", detail: "0 errors, 0 warnings" });

  if (!existsSync(cfg.dbPath)) { checks.push({ name: "index", status: "warn", detail: "no search index yet", fix: "doltap reindex" }); return; }
  const db = new WikiDb(cfg);
  try {
    const files = db.listFiles().length;
    const rows = Number((db.db.prepare("SELECT count(*) AS n FROM pages").get() as { n: number }).n);
    // lint has just reindexed incrementally; a mismatch left after that means unreadable pages or a damaged index.
    if (rows !== files) checks.push({ name: "index", status: "warn", detail: `index has ${rows} pages, wiki/ has ${files} files (broken pages?)`, fix: "doltap reindex --full" });
    else checks.push({ name: "index", status: "ok", detail: `${rows} pages indexed` });
  } finally { db.close(); }
}

function sessionCheck(cfg: WikiConfig, checks: DoctorCheck[], recent: number): void {
  if (!isRepo(cfg)) return;
  const log = git(cfg, ["log", `-n${recent}`, "--format=%s%x1f%b%x1e", "--", "wiki"], { allowFail: true });
  if (!log.ok) return;
  const writes = log.stdout.split("\x1e").map((e) => e.trim()).filter((e) => e.startsWith("wiki: ") && !/\[agent:(scheduler|doltap-init|mcp-http)\]/.test(e) && !/^wiki: (stats|refresh hubs|add tag|remove tag) /.test(e));
  if (!writes.length) { checks.push({ name: "sessions", status: "skip", detail: "no agent writes in recent history" }); return; }
  const missing = writes.filter((e) => !/\[session:/.test(e));
  if (missing.length) checks.push({ name: "sessions", status: "warn", detail: `${missing.length} of the last ${writes.length} agent write(s) carry no session id; wiki_verify cannot tell the author's session apart`, fix: "writers should set DOLTAP_SESSION (Claude Code exports CLAUDE_CODE_SESSION_ID; the MCP server sets one since 0.3.1)" });
  else checks.push({ name: "sessions", status: "ok", detail: `all of the last ${writes.length} agent write(s) carry a session id` });
}

function secretsChecks(cfg: WikiConfig, checks: DoctorCheck[]): void {
  const token = join(cfg.stateDir, "http-token");
  const clients = join(cfg.stateDir, "http-clients.json");
  if (!existsSync(token) && !existsSync(clients)) { checks.push({ name: "secrets", status: "skip", detail: "no HTTP token on this machine" }); return; }
  const problems: string[] = [];
  if (platform() !== "win32") {
    for (const p of [token, clients]) {
      if (!existsSync(p)) continue;
      const mode = statSync(p).mode & 0o777;
      if (mode & 0o077) problems.push(`${p.slice(cfg.stateDir.length + 1)} is mode ${mode.toString(8)} (should be 600)`);
    }
  }
  if (existsSync(token)) {
    const t = readFileSync(token, "utf8").trim();
    if (!/^[0-9a-f]{32,}$/.test(t)) problems.push("http-token is not a hex token");
  }
  if (existsSync(clients)) {
    try {
      const recs = JSON.parse(readFileSync(clients, "utf8")) as Record<string, { token?: string }>;
      for (const [name, rec] of Object.entries(recs)) {
        if (!CLIENT_NAME_RE.test(name)) problems.push(`client "${name.slice(0, 20)}" has an invalid name (ignored by the server)`);
        else if (!/^[0-9a-f]{32,}$/.test(rec?.token ?? "")) problems.push(`client ${name} has no usable token`);
      }
    } catch (e) { problems.push(`http-clients.json does not parse: ${(e as Error).message.split("\n")[0]}`); }
  }
  if (problems.length) checks.push({ name: "secrets", status: "fail", detail: problems.join("; "), fix: "chmod 600 the files; recreate bad client entries with doltap serve client add" });
  else checks.push({ name: "secrets", status: "ok", detail: "token files private and well-formed" });
}

function logsCheck(cfg: WikiConfig, checks: DoctorCheck[], maxBytes: number): void {
  const logs = listLogs(cfg);
  if (!logs.length) { checks.push({ name: "logs", status: "skip", detail: "no service logs" }); return; }
  const big = logs.filter((l) => l.bytes > maxBytes);
  const total = logs.reduce((n, l) => n + l.bytes, 0);
  if (big.length) checks.push({ name: "logs", status: "warn", detail: `${big.map((l) => `${l.name} ${(l.bytes / 1024).toFixed(0)} KB`).join(", ")} over ${Math.round(maxBytes / 1024)} KB`, fix: "doltap sync rotates them" });
  else checks.push({ name: "logs", status: "ok", detail: `${logs.length} file(s), ${(total / 1024).toFixed(0)} KB` });
  const err = logs.find((l) => l.name === "sync.err" && l.bytes > 0);
  if (err) {
    const tail = readFileSync(err.path, "utf8").trim().split("\n").slice(-1)[0] ?? "";
    checks.push({ name: "sync-errors", status: "warn", detail: `sync.err is not empty; last line: ${tail.slice(0, 120)}`, fix: "read .doltap/logs/sync.err; truncate it once the cause is fixed" });
  }
}

function nodeCheck(checks: DoctorCheck[]): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) checks.push({ name: "node", status: "fail", detail: `node ${process.versions.node} is below 22.13 (node:sqlite)`, fix: "install a current LTS line" });
  else if (major % 2 === 1) checks.push({ name: "node", status: "warn", detail: `node ${process.versions.node} is an odd (short-lived) release line`, fix: "prefer an even LTS line on the always-on machine" });
  else checks.push({ name: "node", status: "ok", detail: `node ${process.versions.node}` });
}

async function serviceChecks(cfg: WikiConfig, checks: DoctorCheck[], o: DoctorOptions): Promise<{ scheduled: boolean; interval?: number }> {
  const timeout = o.timeoutMs ?? 3000;
  let scheduled = false;
  let interval: number | undefined;
  try {
    const s = scheduleStatus();
    interval = s.intervalMinutes;
    if (!s.installed) checks.push({ name: "schedule", status: "warn", detail: `no scheduled sync (${s.platform})`, fix: "doltap schedule install" });
    else if (/NOT loaded/.test(s.detail)) checks.push({ name: "schedule", status: "fail", detail: `${s.platform}: installed but not loaded`, fix: "doltap schedule install" });
    else { scheduled = true; checks.push({ name: "schedule", status: "ok", detail: `${s.platform}${interval ? ` every ${interval} min` : ""}` }); }
  } catch (e) { checks.push({ name: "schedule", status: "warn", detail: `cannot query the scheduler: ${(e as Error).message.split("\n")[0]}` }); }

  try {
    const h = httpServiceStatus();
    if (!h.installed) checks.push({ name: "serve", status: "skip", detail: h.detail });
    else if (!h.pid) checks.push({ name: "serve", status: "fail", detail: `${h.platform}: ${h.detail}`, fix: "doltap serve install, then read .doltap/logs/mcp-http.err" });
    else {
      const err = await probe(`http://${h.host}:${h.port}/healthz`, timeout);
      if (err) checks.push({ name: "serve", status: "fail", detail: `pid ${h.pid} but /healthz on ${h.host}:${h.port} failed: ${err}`, fix: "doltap serve install (restarts the service); check .doltap/logs/mcp-http.err" });
      else checks.push({ name: "serve", status: "ok", detail: `running (pid ${h.pid}), /healthz ok on ${h.host}:${h.port}` });
    }
  } catch (e) { checks.push({ name: "serve", status: "warn", detail: `cannot query the service: ${(e as Error).message.split("\n")[0]}` }); }

  return { scheduled, interval };
}

async function remoteHealthCheck(checks: DoctorCheck[], url: string, timeoutMs: number): Promise<void> {
  const err = await probe(url, timeoutMs);
  const shown = url.replace(/\/[0-9a-f]{32,}\/mcp\b/g, "/<token>/mcp");
  checks.push(err ? { name: "remote-healthz", status: "fail", detail: `${shown}: ${err}`, fix: "check the tunnel (tailscale funnel status) and the service" } : { name: "remote-healthz", status: "ok", detail: shown });
}

/** Run every health check the maintenance routine does by hand. Read-only: nothing is synced, rotated or reindexed. */
export async function doctor(cfg: WikiConfig, o: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  nodeCheck(checks);
  repoChecks(cfg, checks);
  const svc = o.services === false ? { scheduled: false, interval: undefined } : await serviceChecks(cfg, checks, o);
  if (o.healthzUrl) await remoteHealthCheck(checks, o.healthzUrl, o.timeoutMs ?? 3000);
  const maxAge = o.maxPullAgeMinutes ?? (svc.interval ? svc.interval * 3 : 60);
  syncAgeCheck(cfg, checks, maxAge, svc.scheduled);
  contentChecks(cfg, checks);
  sessionCheck(cfg, checks, o.recentCommits ?? 30);
  secretsChecks(cfg, checks);
  logsCheck(cfg, checks, o.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES);
  checks.push(...(o.extra ?? []));
  const failures = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  return { root: cfg.root, host: cfg.hostname, checks, failures, warnings, ok: failures === 0 };
}
