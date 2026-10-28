import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CATEGORIES, isCategoryHub, type WikiConfig } from "./config.js";
import { idFromRelPath, parsePage, toPosix, type Page } from "./page.js";

export interface PageRow {
  id: string;
  title: string;
  category: string;
  summary: string;
  tags: string[];
  confidence: string;
  created: string;
  updated: string;
  rel_path: string;
  /** Set on deprecated pages: the id to use instead. */
  replaced_by: string | null;
}

export interface SearchHit extends PageRow {
  /** Final ranking score: bm25 scaled by confidence and recency. Lower is better. */
  score: number;
  /** Raw bm25 from FTS5 (title, summary and tags weighted above body). Lower is better. */
  bm25: number;
  /** Multiplier applied to bm25: verified pages and recent updates rank higher, deprecated pages lower. */
  boost: number;
  snippet: string;
  /** Query terms found in the page (title, summary, tags or body). All of them for an exact match; fewer for a fallback hit. */
  matched: string[];
}

export interface SearchOptions {
  category?: string;
  tag?: string;
  confidence?: string;
  limit?: number;
  includeDeprecated?: boolean;
  /** Also return `Home` and `<category>/_index` pages. Off by default: their summaries only repeat other pages. */
  includeHubs?: boolean;
  /** Reference time for the recency boost (ms since epoch). Defaults to now; tests pin it. */
  now?: number;
}

/**
 * Ranking beyond bm25. bm25 differences between candidate pages are small (a one-word query separates
 * them by a few percent), so every multiplier stays small too; together they decide near-ties, they do
 * not override a clear text match.
 *
 * Multiplier for a page's confidence: a verified page outranks a draft with the same text; deprecated pages sink.
 */
export const CONFIDENCE_BOOST: Record<string, number> = { verified: 1.1, draft: 1.0, deprecated: 0.5 };

/** Query terms found in the title lift a page by up to this share (all terms in the title: ×1.15). */
export const TITLE_BOOST = 0.15;

/** Multiplier by age of `updated`: fresh pages get a small lift, pages untouched for a year a small penalty. */
export function recencyBoost(updated: string, now: number): number {
  const days = (now - Date.parse(updated)) / 86400000;
  if (!Number.isFinite(days)) return 1.0;
  if (days <= 30) return 1.05;
  if (days <= 180) return 1.0;
  if (days <= 365) return 0.95;
  return 0.9;
}

/** Does `text` contain `token` as a word prefix (the same notion of a hit as the FTS prefix query)? */
function containsToken(text: string, token: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(text);
}

export interface BrokenPage {
  id: string;
  relPath: string;
  error: string;
}

/** Bump when the table layout changes: an older index file is dropped and rebuilt on open. */
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL,
  confidence TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  replaced_by TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  id UNINDEXED, title, summary, tags, body, tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS links (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  PRIMARY KEY (src, dst)
);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
CREATE TABLE IF NOT EXISTS access_log (
  id TEXT NOT NULL,
  ts TEXT NOT NULL,
  agent TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_log (
  ts TEXT NOT NULL,
  agent TEXT NOT NULL,
  query TEXT NOT NULL,
  hits TEXT NOT NULL
);
`;

/** Search queries older than this are dropped from the local log on the next search. Never leaves the machine. */
export const SEARCH_LOG_DAYS = 180;

export interface SearchLogEntry {
  ts: string;
  agent: string;
  query: string;
  /** Page ids returned, in rank order. */
  hits: string[];
}

const STOPWORDS = new Set(
  "the a an and or of to in on for with without from by at as is are was be this that it its into via when how what why use using used one two new set get".split(" "),
);

const WORD_SPLIT = /[^\p{L}\p{N}_]+/u;

/** Lowercased alphanumeric tokens, length > 2, minus stopwords and category names. */
export function meaningfulTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(WORD_SPLIT)) {
    if (t.length > 2 && !STOPWORDS.has(t) && !(CATEGORIES as readonly string[]).includes(t)) out.add(t);
  }
  return out;
}

export class WikiDb {
  readonly db: DatabaseSync;
  constructor(readonly cfg: WikiConfig, path = cfg.dbPath) {
    this.db = new DatabaseSync(path);
    // Readers also write (incremental reindex), so a concurrent process must wait instead of failing with "database is locked".
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA journal_mode=WAL");
    const v = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (v !== SCHEMA_VERSION) {
      this.db.exec("DROP TABLE IF EXISTS pages; DROP TABLE IF EXISTS pages_fts; DROP TABLE IF EXISTS links;");
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Walk wiki/ for page files, skipping _meta, dotfiles, conflict copies and symlinks (see listSymlinks). */
  listFiles(): string[] {
    return this.walk().files;
  }

  /** Symlinks under wiki/ (files or directories). They are never read: a link can point outside the wiki. */
  listSymlinks(): string[] {
    return this.walk().symlinks;
  }

  private walk(): { files: string[]; symlinks: string[] } {
    const files: string[] = [];
    const symlinks: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith(".") || ent.name.startsWith("_meta")) continue;
        const p = join(dir, ent.name);
        if (ent.isSymbolicLink()) symlinks.push(p);
        else if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith(".md") && !/\.conflict-[^.]+\.md$/.test(ent.name)) files.push(p);
      }
    };
    walk(this.cfg.wikiDir);
    return { files: files.sort(), symlinks: symlinks.sort() };
  }

  indexPage(page: Page, mtime: number, size: number): void {
    const { meta } = page;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pages (id, rel_path, title, category, summary, tags, confidence, created, updated, mtime, size, replaced_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(page.id, page.relPath, meta.title, meta.category, meta.summary, JSON.stringify(meta.tags), meta.confidence, meta.created, meta.updated, mtime, size, meta.replaced_by ? String(meta.replaced_by) : null);
    this.db.prepare("DELETE FROM pages_fts WHERE id = ?").run(page.id);
    this.db
      .prepare("INSERT INTO pages_fts (id, title, summary, tags, body) VALUES (?,?,?,?,?)")
      .run(page.id, meta.title, meta.summary, meta.tags.join(" "), page.body);
    this.db.prepare("DELETE FROM links WHERE src = ?").run(page.id);
    const ins = this.db.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?,?)");
    for (const dst of page.links) ins.run(page.id, dst);
  }

  removePage(id: string): void {
    this.db.prepare("DELETE FROM pages WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM pages_fts WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM links WHERE src = ?").run(id);
  }

  /**
   * Incremental reindex: re-parse files whose mtime/size changed, drop rows for deleted files.
   * Returns counts. `full` forces re-parsing everything.
   */
  reindex(full = false): { indexed: number; removed: number; total: number; pages: Page[]; broken: BrokenPage[] } {
    const files = this.listFiles();
    const known = new Map<string, { mtime: number; size: number }>();
    for (const r of this.db.prepare("SELECT id, mtime, size FROM pages").all() as { id: string; mtime: number; size: number }[]) {
      known.set(r.id, r);
    }
    const seen = new Set<string>();
    const pages: Page[] = [];
    const broken: BrokenPage[] = [];
    let indexed = 0;
    // IMMEDIATE takes the write lock up front; a deferred transaction that upgrades later can fail with SQLITE_BUSY despite busy_timeout.
    const tx = this.db.prepare("BEGIN IMMEDIATE");
    tx.run();
    try {
      for (const abs of files) {
        const rel = relative(this.cfg.wikiDir, abs);
        const st = statSync(abs);
        const mtime = Math.floor(st.mtimeMs);
        let page: Page;
        try {
          page = parsePage(this.cfg, rel, readFileSync(abs, "utf8"));
        } catch (e) {
          // One malformed page must not take search, get and lint down with it: drop its row and report it.
          broken.push({ id: idFromRelPath(rel), relPath: toPosix(rel), error: e instanceof Error ? e.message : String(e) });
          continue;
        }
        seen.add(page.id);
        pages.push(page);
        const prev = known.get(page.id);
        if (!full && prev && prev.mtime === mtime && prev.size === st.size) continue;
        this.indexPage(page, mtime, st.size);
        indexed++;
      }
      let removed = 0;
      for (const id of known.keys()) {
        if (!seen.has(id)) {
          this.removePage(id);
          removed++;
        }
      }
      this.db.prepare("COMMIT").run();
      return { indexed, removed, total: files.length - broken.length, pages, broken };
    } catch (e) {
      this.db.prepare("ROLLBACK").run();
      throw e;
    }
  }

  private rowToPage(r: Record<string, unknown>): PageRow {
    return {
      id: String(r.id),
      title: String(r.title),
      category: String(r.category),
      summary: String(r.summary),
      tags: JSON.parse(String(r.tags)) as string[],
      confidence: String(r.confidence),
      created: String(r.created),
      updated: String(r.updated),
      rel_path: String(r.rel_path),
      replaced_by: r.replaced_by == null ? null : String(r.replaced_by),
    };
  }

  getRow(id: string): PageRow | null {
    const r = this.db.prepare("SELECT * FROM pages WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToPage(r) : null;
  }

  allIds(): Set<string> {
    return new Set((this.db.prepare("SELECT id FROM pages").all() as { id: string }[]).map((r) => r.id));
  }

  list(o: SearchOptions = {}): PageRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (o.category) { where.push("category = ?"); args.push(o.category); }
    if (o.confidence) { where.push("confidence = ?"); args.push(o.confidence); }
    else if (!o.includeDeprecated) where.push("confidence != 'deprecated'");
    const rows = this.db
      .prepare(`SELECT * FROM pages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`)
      .all(...args) as Record<string, unknown>[];
    let out = rows.map((r) => this.rowToPage(r));
    if (o.tag) out = out.filter((p) => p.tags.includes(o.tag!));
    return out;
  }

  /** Query tokens: lowercased words (any script), length > 1, stopwords removed unless nothing else is left. */
  static queryTokens(q: string): string[] {
    const all = q.toLowerCase().split(WORD_SPLIT).filter((t) => t.length > 1);
    const kept = all.filter((t) => !STOPWORDS.has(t));
    return [...new Set(kept.length ? kept : all)];
  }

  /** Turn free text into an FTS5 query: each token becomes a prefix term, joined by implicit AND. */
  static toFtsQuery(q: string, op: "AND" | "OR" = "AND"): string {
    const tokens = WikiDb.queryTokens(q);
    if (!tokens.length) return "";
    return tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(op === "OR" ? " OR " : " ");
  }

  private searchOnce(fts: string, tokens: string[], o: SearchOptions, limit: number): (SearchHit & { text: string })[] {
    const where: string[] = ["pages_fts MATCH ?"];
    const args: (string | number)[] = [fts];
    if (o.category) { where.push("p.category = ?"); args.push(o.category); }
    if (o.confidence) { where.push("p.confidence = ?"); args.push(o.confidence); }
    else if (!o.includeDeprecated) where.push("p.confidence != 'deprecated'");
    if (o.tag) { where.push("p.tags LIKE ?"); args.push(`%${JSON.stringify(o.tag)}%`); }
    // Category hubs are `<category>/_index` (one slash); project hubs `projects/<name>/_index` are content and stay.
    if (!o.includeHubs) where.push("p.id != 'Home' AND NOT (p.id GLOB '*/_index' AND p.id NOT GLOB '*/*/_index')");
    // Weight title and summary and tags above body.
    const sql = `
      SELECT p.*, bm25(pages_fts, 0, 10.0, 6.0, 4.0, 1.0) AS score,
             snippet(pages_fts, 4, '**', '**', ' … ', 12) AS snippet,
             pages_fts.body AS body
      FROM pages_fts JOIN pages p ON p.id = pages_fts.id
      WHERE ${where.join(" AND ")}
      ORDER BY score LIMIT ?`;
    args.push(limit);
    const now = o.now ?? Date.now();
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => {
      const row = this.rowToPage(r);
      const bm25 = Number(r.score);
      const title = row.title.toLowerCase();
      const inTitle = tokens.filter((t) => containsToken(title, t)).length / tokens.length;
      const boost = (CONFIDENCE_BOOST[row.confidence] ?? 1.0) * recencyBoost(row.updated, now) * (1 + TITLE_BOOST * inTitle);
      return { ...row, score: bm25 * boost, bm25, boost, snippet: String(r.snippet), matched: [], text: `${row.title} ${row.summary} ${row.tags.join(" ")} ${String(r.body)}`.toLowerCase() };
    });
  }

  /**
   * Full-text search. Every term must match first (precise); when that yields fewer than `limit` hits,
   * pages matching some of the terms are appended, ranked by how many terms they contain and then by score.
   * The score is bm25 scaled by confidence and recency (see CONFIDENCE_BOOST, recencyBoost); deprecated
   * pages, when included at all, come after every live page.
   * A natural-language query with one word the wiki never uses therefore still finds the right page.
   */
  search(query: string, o: SearchOptions = {}): SearchHit[] {
    const tokens = WikiDb.queryTokens(query);
    if (!tokens.length) return [];
    const limit = o.limit ?? 10;
    const hits = new Map<string, SearchHit & { text: string; exact: boolean }>();
    for (const h of this.searchOnce(WikiDb.toFtsQuery(query, "AND"), tokens, o, limit)) hits.set(h.id, { ...h, exact: true });
    // Fallback hits must still contain at least half of the terms (and at least two), so a single common word never drags in noise.
    const minMatched = Math.max(2, Math.ceil(tokens.length / 2));
    if (hits.size < limit && tokens.length > 2) {
      for (const h of this.searchOnce(WikiDb.toFtsQuery(query, "OR"), tokens, o, limit * 3)) if (!hits.has(h.id)) hits.set(h.id, { ...h, exact: false });
    }
    const matchedIn = (text: string) => tokens.filter((t) => containsToken(text, t));
    return [...hits.values()]
      .map((h) => ({ ...h, matched: h.exact ? tokens : matchedIn(h.text) }))
      .filter((h) => h.exact || h.matched.length >= minMatched)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.matched.length - a.matched.length || Number(a.confidence === "deprecated") - Number(b.confidence === "deprecated") || a.score - b.score)
      .slice(0, limit)
      .map(({ text: _t, exact: _e, ...hit }) => hit);
  }

  /**
   * Duplicate detection. Candidates come from an OR query over title/summary/tags (body ignored);
   * each candidate is then scored by the share of the probe's meaningful tokens it also contains.
   * Returns candidates with overlap >= minOverlap and at least minShared shared tokens.
   */
  similar(text: string, limit = 5, minOverlap = 0.5, minShared = 3): SearchHit[] {
    const probe = meaningfulTokens(text);
    if (probe.size < 2) return [];
    const fts = [...probe].map((t) => `"${t}"`).join(" OR ");
    const sql = `
      SELECT p.*, bm25(pages_fts, 0, 10.0, 6.0, 4.0, 0.0) AS score, '' AS snippet
      FROM pages_fts JOIN pages p ON p.id = pages_fts.id
      WHERE pages_fts MATCH ? AND p.confidence != 'deprecated'
      ORDER BY score LIMIT 25`;
    const rows = (this.db.prepare(sql).all(fts) as Record<string, unknown>[]).map((r) => ({
      ...this.rowToPage(r),
      score: Number(r.score),
      snippet: String(r.snippet),
    }));
    const scored = rows
      .filter((r) => !isCategoryHub(r.id))
      .map((r) => {
        const own = meaningfulTokens(`${r.title} ${r.summary} ${r.id.replace(/[/-]/g, " ")}`);
        const matched = [...probe].filter((t) => own.has(t));
        return { hit: r, matched, shared: matched.length, overlap: matched.length / probe.size };
      })
      .filter((x) => x.shared >= minShared && x.overlap >= minOverlap)
      .sort((a, b) => b.overlap - a.overlap);
    return scored.slice(0, limit).map((x) => ({ ...x.hit, score: -x.overlap, bm25: x.hit.score, boost: 1, snippet: `${x.shared}/${probe.size} tokens shared`, matched: x.matched }));
  }

  outlinks(id: string): string[] {
    return (this.db.prepare("SELECT dst FROM links WHERE src = ? ORDER BY dst").all(id) as { dst: string }[]).map((r) => r.dst);
  }

  backlinks(id: string): string[] {
    return (this.db.prepare("SELECT src FROM links WHERE dst = ? ORDER BY src").all(id) as { src: string }[]).map((r) => r.src);
  }

  logAccess(id: string): void {
    this.db.prepare("INSERT INTO access_log (id, ts, agent) VALUES (?,?,?)").run(id, new Date().toISOString(), this.cfg.agent);
  }

  /** Record a search in the per-machine index (not in git): query text, caller and the ids returned, in order. */
  logSearch(query: string, hitIds: string[]): void {
    const cutoff = new Date(Date.now() - SEARCH_LOG_DAYS * 86400000).toISOString();
    this.db.prepare("DELETE FROM search_log WHERE ts < ?").run(cutoff);
    this.db.prepare("INSERT INTO search_log (ts, agent, query, hits) VALUES (?,?,?,?)").run(new Date().toISOString(), this.cfg.agent, query, JSON.stringify(hitIds));
  }

  searchLog(sinceIso: string): SearchLogEntry[] {
    const rows = this.db.prepare("SELECT ts, agent, query, hits FROM search_log WHERE ts >= ? ORDER BY ts").all(sinceIso) as { ts: string; agent: string; query: string; hits: string }[];
    return rows.map((r) => ({ ts: r.ts, agent: r.agent, query: r.query, hits: JSON.parse(r.hits) as string[] }));
  }

  /** The first page `agent` opened after `tsIso` and within `withinMs`, if any. */
  nextAccess(agent: string, tsIso: string, withinMs: number): { id: string; ts: string } | null {
    const until = new Date(Date.parse(tsIso) + withinMs).toISOString();
    const r = this.db.prepare("SELECT id, ts FROM access_log WHERE agent = ? AND ts > ? AND ts <= ? ORDER BY ts LIMIT 1").get(agent, tsIso, until) as { id: string; ts: string } | undefined;
    return r ?? null;
  }

  accessCounts(sinceIso: string): Map<string, number> {
    const rows = this.db.prepare("SELECT id, COUNT(*) c FROM access_log WHERE ts >= ? GROUP BY id").all(sinceIso) as { id: string; c: number }[];
    return new Map(rows.map((r) => [r.id, r.c]));
  }
}
