import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCategoryHub, type WikiConfig } from "./config.js";
import { WikiDb, type PageRow } from "./db.js";
import { assertOnBranch, commitAndPush, listConflictFiles, readSyncState, writeSyncState, type SyncReport } from "./git.js";
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
export function publishHostStats(cfg: WikiConfig, db: WikiDb, report: SyncReport, minHours = 6): boolean {
  const state = readSyncState(cfg) as { lastStatsPublish?: string };
  const ageH = state.lastStatsPublish ? (Date.now() - Date.parse(state.lastStatsPublish)) / 3600000 : Infinity;
  if (ageH < minHours) return false;
  const stats = collectHostStats(cfg, db);
  if (!Object.keys(stats.counts).length) return false;
  assertOnBranch(cfg);
  mkdirSync(statsDir(cfg), { recursive: true });
  const file = join(statsDir(cfg), `${cfg.hostname}.json`);
  const next = JSON.stringify({ ...stats, generated: undefined }, null, 2);
  if (existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, "utf8")) as HostStats;
    if (JSON.stringify({ ...prev, generated: undefined }, null, 2) === next) return false;
  }
  writeFileSync(file, JSON.stringify(stats, null, 2) + "\n");
  commitAndPush(cfg, [join("wiki", "_meta", "stats", `${cfg.hostname}.json`)], `wiki: stats ${cfg.hostname}\n\n[host:${cfg.hostname}] [agent:${cfg.agent}]`, report);
  writeSyncState(cfg, { lastStatsPublish: new Date().toISOString() } as Record<string, unknown>);
  return true;
}

export function loadAllStats(cfg: WikiConfig): HostStats[] {
  const dir = statsDir(cfg);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as HostStats);
}

export interface AuditOptions {
  /** Pages not read by any host within this many days are "unreferenced". */
  unreferencedDays?: number;
  /** Pages whose `updated` is older than this are "stale". */
  staleDays?: number;
  /** Drafts older than this (by `created`) are "lingering". */
  draftDays?: number;
}

export interface AuditEntry {
  id: string;
  confidence: string;
  updated: string;
  reads: number;
  lastRead: string | null;
  hosts: string[];
}

export interface AuditReport {
  generated: string;
  hostsReporting: string[];
  thresholds: Required<AuditOptions>;
  unreferenced: AuditEntry[];
  stale: AuditEntry[];
  lingeringDrafts: AuditEntry[];
  orphans: string[];
  deprecatedStillLinked: { id: string; linkedFrom: string[] }[];
  conflictFiles: string[];
  /** Tags in tags.yaml that no page uses. */
  unusedTags: string[];
  mostRead: AuditEntry[];
}

function daysAgo(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 86400000;
}

export function audit(cfg: WikiConfig, o: AuditOptions = {}): AuditReport {
  const thresholds = { unreferencedDays: o.unreferencedDays ?? 90, staleDays: o.staleDays ?? 90, draftDays: o.draftDays ?? 30 };
  const db = new WikiDb(cfg);
  try {
    db.reindex();
    // Merge this host's live log with every published stats file (including an older copy of our own).
    const all = loadAllStats(cfg).filter((s) => s.host !== cfg.hostname);
    all.push(collectHostStats(cfg, db, thresholds.unreferencedDays));
    const reads = new Map<string, AuditEntry>();
    const rows = db.list({ includeDeprecated: true }).filter((r) => !isCategoryHub(r.id));
    const entry = (r: PageRow): AuditEntry => reads.get(r.id) ?? { id: r.id, confidence: r.confidence, updated: r.updated, reads: 0, lastRead: null, hosts: [] };
    for (const r of rows) reads.set(r.id, entry(r));
    for (const s of all) {
      for (const [id, c] of Object.entries(s.counts)) {
        const e = reads.get(id);
        if (!e) continue;
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
    const unreferenced = active.filter((e) => e.reads === 0 && daysAgo(e.updated) > thresholds.unreferencedDays);
    const stale = active.filter((e) => daysAgo(e.updated) > thresholds.staleDays);
    const lingeringDrafts = active.filter((e) => e.confidence === "draft" && daysAgo(rowsById(rows, e.id).created) > thresholds.draftDays);
    const orphans = active.filter((e) => (inbound.get(e.id) ?? []).filter((s) => !s.endsWith("/_index")).length === 0 && (inbound.get(e.id) ?? []).length === 0).map((e) => e.id);
    const deprecatedStillLinked = entries
      .filter((e) => e.confidence === "deprecated")
      .map((e) => ({ id: e.id, linkedFrom: (inbound.get(e.id) ?? []).filter((s) => !s.endsWith("/_index")) }))
      .filter((x) => x.linkedFrom.length);
    const mostRead = [...entries].sort((a, b) => b.reads - a.reads).filter((e) => e.reads > 0).slice(0, 10);
    return {
      generated: new Date().toISOString(),
      hostsReporting: all.map((s) => s.host),
      thresholds,
      unreferenced,
      stale,
      lingeringDrafts,
      orphans,
      deprecatedStillLinked,
      conflictFiles: listConflictFiles(cfg),
      unusedTags: loadTags(cfg).map((t) => t.tag).filter((t) => !rows.some((r) => r.tags.includes(t)) && t !== "wiki"),
      mostRead,
    };
  } finally {
    db.close();
  }
}

function rowsById(rows: PageRow[], id: string): PageRow {
  return rows.find((r) => r.id === id)!;
}
