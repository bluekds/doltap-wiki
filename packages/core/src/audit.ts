import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { readSafe, writeSafe } from "./safe.js";
import { join } from "node:path";
import { DURABLE_CATEGORIES, REVIEW_DEFAULT_DAYS, isCategoryHub, today, type WikiConfig } from "./config.js";
import { WikiDb, type PageRow } from "./db.js";
import { assertOnBranch, commitAndPush, commitMessage, listConflictFiles, readSyncState, writeSyncState, type SyncReport } from "./git.js";
import { withWriteLock, type LockOptions } from "./lock.js";
import { loadTags } from "./tags.js";

/** Per-host access counts shared through git: wiki/_meta/stats/<host>.json */
export interface HostStats {
  host: string;
  generated: string;
  windowDays: number;
  counts: Record<string, number>;
  lastAccess: Record<string, string>;
}

function statsDir(cfg: WikiConfig): string {
  return join(cfg.wikiDir, "_meta", "stats");
}

export function collectHostStats(cfg: WikiConfig, db: WikiDb, windowDays = 90): HostStats {
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  const rows = db.db
    .prepare("SELECT id, COUNT(*) c, MAX(ts) last FROM access_log WHERE ts >= ? GROUP BY id ORDER BY id")
    .all(since) as { id: string; c: number; last: string }[];
  const counts: Record<string, number> = {};
  const lastAccess: Record<string, string> = {};
  for (const r of rows) {
    counts[r.id] = r.c;
    lastAccess[r.id] = r.last.slice(0, 10);
  }
  return { host: cfg.hostname, generated: new Date().toISOString().slice(0, 10), windowDays, counts, lastAccess };
}

/**
 * Write this host's stats file and commit it when the counts changed and the last publish is older
 * than `minHours`. Called from `doltap sync`. Separate files per host never conflict.
 */
export function publishHostStats(cfg: WikiConfig, db: WikiDb, report: SyncReport, minHours = 6, lock: LockOptions = {}): boolean {
  const state = readSyncState(cfg) as { lastStatsPublish?: string };
  const ageH = state.lastStatsPublish ? (Date.now() - Date.parse(state.lastStatsPublish)) / 3600000 : Infinity;
  if (ageH < minHours) return false;
  const stats = collectHostStats(cfg, db);
  if (!Object.keys(stats.counts).length) return false;
  // The commit goes through the machine write lock like every other: a page write in another process
  // must not find its index.lock taken or its hub edit interleaved with this commit.
  return withWriteLock(cfg, () => {
    assertOnBranch(cfg);
    mkdirSync(statsDir(cfg), { recursive: true });
    const file = join(statsDir(cfg), `${cfg.hostname}.json`);
    const next = JSON.stringify({ ...stats, generated: undefined }, null, 2);
    if (existsSync(file)) {
      const prev = JSON.parse(readSafe(cfg.root, file)) as HostStats;
      if (JSON.stringify({ ...prev, generated: undefined }, null, 2) === next) return false;
    }
    writeSafe(cfg.root, file, JSON.stringify(stats, null, 2) + "\n");
    commitAndPush(cfg, [join("wiki", "_meta", "stats", `${cfg.hostname}.json`)], commitMessage(cfg, "stats", cfg.hostname), report);
    writeSyncState(cfg, { lastStatsPublish: new Date().toISOString() } as Record<string, unknown>);
    return true;
  }, lock);
}

export function loadAllStats(cfg: WikiConfig): HostStats[] {
  const dir = statsDir(cfg);
  if (!existsSync(dir)) return [];
  const out: HostStats[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    // Another host's file is data from the remote: a symlink or malformed JSON is skipped (lint and doctor report it), not fatal.
    try { out.push(JSON.parse(readSafe(cfg.root, join(dir, f))) as HostStats); } catch { /* skipped */ }
  }
  return out;
}

export interface AuditOptions {
  /** Pages not read by any host within this many days are "unreferenced". */
  unreferencedDays?: number;
  /**
   * Overrides the per-category review window (REVIEW_DEFAULT_DAYS) for volatile pages without `review_by`.
   * Null (the default) keeps the category defaults.
   */
  reviewDays?: number | null;
  /** Drafts older than this (by `created`) are "lingering". */
  draftDays?: number;
}

export interface AuditEntry {
  id: string;
  category: string;
  confidence: string;
  updated: string;
  /** Lifecycle dates (null when unset). */
  reviewBy: string | null;
  verifiedOn: string | null;
  reads: number;
  lastRead: string | null;
  hosts: string[];
}

export interface AuditReport {
  generated: string;
  hostsReporting: string[];
  thresholds: Required<AuditOptions>;
  /** Volatile pages (not decisions/projects) nobody read in the window and nobody updated: a discoverability check, not a deprecation list. */
  unreferenced: AuditEntry[];
  /** Volatile pages whose `review_by` has passed, or without one, whose last verification/update exceeds the category window. */
  unreviewed: AuditEntry[];
  lingeringDrafts: AuditEntry[];
  orphans: string[];
  deprecatedStillLinked: { id: string; linkedFrom: string[] }[];
  conflictFiles: string[];
  /** Tags in tags.yaml that no page uses. */
  unusedTags: string[];
  mostRead: AuditEntry[];
  /** Searches on this host in the window whose follow-up read was not the first hit (or not a hit at all). */
  searchMisses: SearchMiss[];
  /** Searches logged on this host in the window. */
  searchCount: number;
}

/**
 * A query whose answer was not the first result: the page the same caller opened right after
 * searching was further down (`rank`) or absent (`rank` null). Grouped by query and page.
 * Only this host's log is used; search queries are never published to the shared repository.
 */
export interface SearchMiss {
  query: string;
  opened: string;
  rank: number | null;
  count: number;
  last: string;
}

/** A read within this long after a search counts as its follow-up. */
export const SEARCH_FOLLOW_UP_MS = 15 * 60 * 1000;

export function searchMisses(db: WikiDb, sinceIso: string, limit = 20): { misses: SearchMiss[]; count: number } {
  const log = db.searchLog(sinceIso);
  const grouped = new Map<string, SearchMiss>();
  for (const s of log) {
    const next = db.nextAccess(s.agent, s.ts, SEARCH_FOLLOW_UP_MS);
    if (!next) continue;
    const i = s.hits.indexOf(next.id);
    if (i === 0) continue;
    const key = `${s.query.toLowerCase().trim()}\u0000${next.id}`;
    const m = grouped.get(key) ?? { query: s.query.trim(), opened: next.id, rank: i < 0 ? null : i + 1, count: 0, last: s.ts.slice(0, 10) };
    m.count += 1;
    m.rank = i < 0 ? null : i + 1;
    if (s.ts.slice(0, 10) > m.last) m.last = s.ts.slice(0, 10);
    grouped.set(key, m);
  }
  return { misses: [...grouped.values()].sort((a, b) => b.count - a.count || a.query.localeCompare(b.query)).slice(0, limit), count: log.length };
}

function daysAgo(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 86400000;
}

export function audit(cfg: WikiConfig, o: AuditOptions = {}): AuditReport {
  const thresholds = { unreferencedDays: o.unreferencedDays ?? 90, reviewDays: o.reviewDays ?? null, draftDays: o.draftDays ?? 30 };
  const todayIso = today();
  const db = new WikiDb(cfg);
  try {
    db.reindex();
    // Merge this host's live log with every published stats file (including an older copy of our own).
    const all = loadAllStats(cfg).filter((s) => s.host !== cfg.hostname);
    all.push(collectHostStats(cfg, db, thresholds.unreferencedDays));
    const windowStart = new Date(Date.now() - thresholds.unreferencedDays * 86400000).toISOString().slice(0, 10);
    const reads = new Map<string, AuditEntry>();
    const rows = db.list({ includeDeprecated: true }).filter((r) => !isCategoryHub(r.id));
    const entry = (r: PageRow): AuditEntry => reads.get(r.id) ?? { id: r.id, category: r.category, confidence: r.confidence, updated: r.updated, reviewBy: r.review_by, verifiedOn: r.verified_on, reads: 0, lastRead: null, hosts: [] };
    for (const r of rows) reads.set(r.id, entry(r));
    for (const s of all) {
      for (const [id, c] of Object.entries(s.counts)) {
        const e = reads.get(id);
        if (!e) continue;
        // A published file keeps counting for ever once its host stops syncing; only reads inside the window count (audit L7).
        const lastSeen = s.lastAccess[id];
        if (lastSeen && lastSeen.slice(0, 10) < windowStart) continue;
        e.reads += c;
        e.hosts.push(s.host);
        const last = s.lastAccess[id];
        if (last && (!e.lastRead || last > e.lastRead)) e.lastRead = last;
      }
    }
    const entries = [...reads.values()];
    const active = entries.filter((e) => e.confidence !== "deprecated");
    const inbound = new Map<string, string[]>();
    for (const r of db.db.prepare("SELECT src, dst FROM links").all() as { src: string; dst: string }[]) {
      inbound.set(r.dst, [...(inbound.get(r.dst) ?? []), r.src]);
    }
    const volatile = active.filter((e) => !DURABLE_CATEGORIES.includes(e.category));
    const unreferenced = volatile.filter((e) => e.reads === 0 && daysAgo(e.updated) > thresholds.unreferencedDays);
    const unreviewed = volatile.filter((e) => {
      if (e.reviewBy) return e.reviewBy < todayIso;
      const window = thresholds.reviewDays ?? REVIEW_DEFAULT_DAYS[e.category];
      return window !== undefined && daysAgo(e.verifiedOn ?? e.updated) > window;
    });
    const lingeringDrafts = active.filter((e) => e.confidence === "draft" && daysAgo(rowsById(rows, e.id).created) > thresholds.draftDays);
    const orphans = active.filter((e) => (inbound.get(e.id) ?? []).filter((s) => !s.endsWith("/_index")).length === 0 && (inbound.get(e.id) ?? []).length === 0).map((e) => e.id);
    const deprecatedStillLinked = entries
      .filter((e) => e.confidence === "deprecated")
      .map((e) => ({ id: e.id, linkedFrom: (inbound.get(e.id) ?? []).filter((s) => !s.endsWith("/_index")) }))
      .filter((x) => x.linkedFrom.length);
    const mostRead = [...entries].sort((a, b) => b.reads - a.reads).filter((e) => e.reads > 0).slice(0, 10);
    const searches = searchMisses(db, new Date(Date.now() - thresholds.unreferencedDays * 86400000).toISOString());
    return {
      generated: new Date().toISOString(),
      hostsReporting: all.map((s) => s.host),
      thresholds,
      unreferenced,
      unreviewed,
      lingeringDrafts,
      orphans,
      deprecatedStillLinked,
      conflictFiles: listConflictFiles(cfg),
      unusedTags: loadTags(cfg).map((t) => t.tag).filter((t) => !rows.some((r) => r.tags.includes(t)) && t !== "wiki"),
      mostRead,
      searchMisses: searches.misses,
      searchCount: searches.count,
    };
  } finally {
    db.close();
  }
}

function rowsById(rows: PageRow[], id: string): PageRow {
  return rows.find((r) => r.id === id)!;
}
