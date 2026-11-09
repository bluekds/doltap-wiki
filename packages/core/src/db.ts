import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { join, relative } from "node:path";
import { CATEGORIES, DURABLE_CATEGORIES, isCategoryHub, type WikiConfig } from "./config.js";
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
  /** Lifecycle dates (0.7): when the page should be re-checked, and when it was last verified. */
  review_by: string | null;
  verified_on: string | null;
  /** Other names for the subject (frontmatter `aliases`, 0.13). */
  aliases: string[];
}

export interface SearchHit extends PageRow {
  /** Final ranking score: bm25 scaled by confidence and recency. Lower is better. */
  score: number;
  /** Raw bm25 from FTS5 (title, summary and tags weighted above body). Lower is better. */
  bm25: number;
  /** Multiplier applied to bm25: verified pages and recent updates rank higher, deprecated pages lower. */
  boost: number;
  snippet: string;
  /** Query terms found in the page (title, aliases, summary, tags or body). */
  matched: string[];
  /** Query terms the page does not contain. */
  unmatched: string[];
  /**
   * Share of the query this page covers, each term weighted by its rarity in the wiki (0..1, two decimals). Low
   * coverage on every hit means the wiki has no page for the question; the missing terms say what is absent.
   */
  coverage: number;
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
export const TITLE_BOOST = 0.3;

/** Pages created or verified within this many days get the recency lift. */
export const RECENT_DAYS = 30;

/**
 * A small lift for a page created or verified recently (keyed on `verified_on` when present, else `created`).
 * Age is never a penalty: a correct page that nobody needed to edit must not sink below a churned one.
 * Durable categories (decisions, projects) get no lift at all; a decision made last week is not more relevant.
 */
export function recencyBoost(row: { category: string; created: string; verified_on: string | null }, now: number): number {
  if (DURABLE_CATEGORIES.includes(row.category)) return 1.0;
  const days = (now - Date.parse(row.verified_on || row.created)) / 86400000;
  if (!Number.isFinite(days)) return 1.0;
  return days <= RECENT_DAYS ? 1.05 : 1.0;
}

/** Does `text` contain `token` as a word prefix (the same notion of a hit as the FTS prefix query)? */
function containsToken(text: string, token: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(text);
}

export interface ReindexResult {
  /** Pages (re)parsed and written to the index. */
  indexed: number;
  /** Rows dropped because the file is gone or no longer parses. */
  removed: number;
  /** Page files that parse (or were unchanged since they last did). */
  total: number;
  /** Set only when requested with `{ pages: true }`: every page, parsed. */
  pages?: Page[];
  broken: BrokenPage[];
}

export interface BrokenPage {
  id: string;
  relPath: string;
  error: string;
}

/** Bump when the table layout changes: an older index file is dropped and rebuilt on open. */
const SCHEMA_VERSION = 5;

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
  replaced_by TEXT,
  review_by TEXT,
  verified_on TEXT,
  aliases TEXT NOT NULL DEFAULT '[]'
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

/**
 * Words dropped from a search query. Unlike STOPWORDS (duplicate detection over titles), `set` and `new` stay:
 * "set up the wiki on a new machine" means setup and a new machine. Question and auxiliary words go: an agent
 * types "where does the wiki run launchd services", and requiring `where` and `does` made the AND query favour
 * whichever long page happened to contain them.
 */
const QUERY_STOPWORDS = new Set([
  ...[...STOPWORDS].filter((w) => w !== "set" && w !== "new"),
  ..."where which who whom whose does do did done can could should would will shall may might must has have had about after before then than there here not no my your our me we you i so if all any some other another up out over also just only".split(" "),
]);

const WORD_SPLIT = /[^\p{L}\p{N}_]+/u;
export const QUERY_MAX_CHARS = 500;
export const QUERY_MAX_TOKENS = 32;

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
    // 15 s: a full reindex of a few thousand pages in another process must finish before this one gives up.
    this.db.exec("PRAGMA busy_timeout=15000");
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

  /** Walk wiki/ for page files, skipping _meta, _assets, dotfiles, conflict copies and symlinks (see listSymlinks). */
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
        if (ent.name.startsWith(".") || ent.name.startsWith("_meta") || ent.name === "_assets") continue;
        const p = join(dir, ent.name);
        if (ent.isSymbolicLink()) symlinks.push(p);
        else if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith(".md") && !/\.conflict-[^.]+\.md$/.test(ent.name)) files.push(p);
      }
    };
    walk(this.cfg.wikiDir);
    return { files: files.sort(), symlinks: symlinks.sort() };
  }

  /** The FTS row of a page shares the page's rowid, so it can be deleted by key instead of by scanning the UNINDEXED id column. */
  private dropFts(id: string): void {
    this.db.prepare("DELETE FROM pages_fts WHERE rowid = (SELECT rowid FROM pages WHERE id = ?)").run(id);
  }

  indexPage(page: Page, mtime: number, size: number): void {
    const { meta } = page;
    this.dropFts(page.id);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pages (id, rel_path, title, category, summary, tags, confidence, created, updated, mtime, size, replaced_by, review_by, verified_on, aliases)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(page.id, page.relPath, meta.title, meta.category, meta.summary, JSON.stringify(meta.tags), meta.confidence, meta.created, meta.updated, mtime, size, meta.replaced_by ? String(meta.replaced_by) : null, meta.review_by ?? null, meta.verified_on ?? null, JSON.stringify(meta.aliases ?? []));
    this.db
      .prepare("INSERT INTO pages_fts (rowid, id, title, summary, tags, body) VALUES ((SELECT rowid FROM pages WHERE id = ?),?,?,?,?,?)")
      // Aliases go into the title column: other names for the subject weigh like its title.
      .run(page.id, page.id, [meta.title, ...(meta.aliases ?? [])].join(" · "), meta.summary, meta.tags.join(" "), page.body);
    this.db.prepare("DELETE FROM links WHERE src = ?").run(page.id);
    const ins = this.db.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?,?)");
    for (const dst of page.links) ins.run(page.id, dst);
  }

  removePage(id: string): void {
    this.dropFts(id);
    this.db.prepare("DELETE FROM pages WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM links WHERE src = ?").run(id);
  }

  /**
   * Incremental reindex: stat every page file, re-parse only those whose mtime or size differs from the
   * indexed row, drop rows for deleted files. Unchanged pages are neither read nor parsed, so a request
   * on a quiet wiki costs one stat per page. `full` re-parses everything; `pages: true` additionally
   * parses the unchanged pages and returns them all (lint, assets), reporting any that no longer parse.
   */
  reindex(full?: boolean): ReindexResult;
  reindex(full: boolean, o: { pages: true }): ReindexResult & { pages: Page[] };
  reindex(full = false, o: { pages?: boolean } = {}): ReindexResult {
    const files = this.listFiles();
    const known = new Map<string, { mtime: number; size: number }>();
    for (const r of this.db.prepare("SELECT id, mtime, size FROM pages").all() as { id: string; mtime: number; size: number }[]) {
      known.set(r.id, r);
    }
    const seen = new Set<string>();
    const pages: Page[] = [];
    const broken: BrokenPage[] = [];
    let indexed = 0;
    let vanished = 0;
    // IMMEDIATE takes the write lock up front; a deferred transaction that upgrades later can fail with SQLITE_BUSY despite busy_timeout.
    const tx = this.db.prepare("BEGIN IMMEDIATE");
    tx.run();
    try {
      for (const abs of files) {
        const rel = relative(this.cfg.wikiDir, abs);
        const id = idFromRelPath(rel);
        let st: Stats;
        try { st = statSync(abs); } catch (e) {
          // Deleted between the directory walk and now (a pull in another process): simply not here any more.
          if ((e as NodeJS.ErrnoException).code === "ENOENT") { vanished++; continue; }
          throw e;
        }
        const mtime = Math.floor(st.mtimeMs);
        const prev = known.get(id);
        const unchanged = !full && prev !== undefined && prev.mtime === mtime && prev.size === st.size;
        if (unchanged && !o.pages) { seen.add(id); continue; }
        let page: Page;
        try {
          page = parsePage(this.cfg, rel, readFileSync(abs, "utf8"));
        } catch (e) {
          // One malformed page must not take search, get and lint down with it: drop its row and report it.
          broken.push({ id, relPath: toPosix(rel), error: e instanceof Error ? e.message : String(e) });
          continue;
        }
        seen.add(page.id);
        pages.push(page);
        if (unchanged) continue;
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
      const r: ReindexResult = { indexed, removed, total: files.length - broken.length - vanished, broken };
      if (o.pages) r.pages = pages;
      return r;
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
      review_by: r.review_by == null ? null : String(r.review_by),
      verified_on: r.verified_on == null ? null : String(r.verified_on),
      aliases: r.aliases == null ? [] : (JSON.parse(String(r.aliases)) as string[]),
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
    // Cap the terms: every token costs an FTS prefix term plus a regex per candidate hit (audit S6).
    const all = q.slice(0, QUERY_MAX_CHARS).toLowerCase().split(WORD_SPLIT).filter((t) => t.length > 1).slice(0, QUERY_MAX_TOKENS);
    const kept = all.filter((t) => !QUERY_STOPWORDS.has(t));
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
      // The slug counts as title: `howto/setup-wiki-on-new-machine` answers "set up wiki on a new machine" even
      // when the title words differ. With common query words bm25 is near zero and this is the main signal.
      const title = `${row.title} ${row.aliases.join(" ")} ${row.id.split("/").pop()!.replace(/-/g, " ")}`.toLowerCase();
      const inTitle = tokens.filter((t) => containsToken(title, t)).length / tokens.length;
      const boost = (CONFIDENCE_BOOST[row.confidence] ?? 1.0) * recencyBoost(row, now) * (1 + TITLE_BOOST * inTitle);
      return { ...row, score: bm25 * boost, bm25, boost, snippet: String(r.snippet), matched: [], unmatched: [], coverage: 0, text: `${row.title} ${row.aliases.join(" ")} ${row.summary} ${row.tags.join(" ")} ${String(r.body)}`.toLowerCase() };
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
    // One candidate pool from the OR query, ranked by bm25, which already weighs each matched term by its rarity
    // and normalises for field length. Until 0.12 pages containing every term were put first whatever their score,
    // so a long handbook that mentions everything beat the page whose title answers the question but lacks one
    // generic word ("call the gb10 server from another machine"). Fetch more candidates than asked for: the boosts
    // re-rank them, and the first hit must not depend on how many were requested (audit L1).
    const pool = this.searchOnce(WikiDb.toFtsQuery(query, tokens.length > 1 ? "OR" : "AND"), tokens, o, limit * 5);
    // Which terms a hit contains is decided by FTS itself (stems, folded diacritics), not by a literal scan:
    // "deploying" matches a page that says "deployed" (audit M3). The literal scan only adds to it.
    const ids = pool.map((h) => h.id);
    const byFts = new Map<string, Set<string>>();
    if (ids.length && tokens.length > 1) {
      const sql = `SELECT id FROM pages_fts WHERE pages_fts MATCH ? AND id IN (${ids.map(() => "?").join(",")})`;
      for (const t of tokens) {
        for (const r of this.db.prepare(sql).all(`"${t.replace(/"/g, "")}"*`, ...ids) as { id: string }[]) {
          if (!byFts.has(r.id)) byFts.set(r.id, new Set());
          byFts.get(r.id)!.add(t);
        }
      }
    }
    const matchedIn = (h: { id: string; text: string }) => (tokens.length === 1 ? tokens : tokens.filter((t) => byFts.get(h.id)?.has(t) || containsToken(h.text, t)));
    // Each term weighs by its rarity across the wiki: missing a distinctive term ("rotate") costs more than
    // missing a generic one ("machine"), which a page answering the question may simply not use.
    const total = (this.db.prepare("SELECT count(*) AS n FROM pages").get() as { n: number }).n || 1;
    const weight = new Map<string, number>();
    for (const t of tokens) {
      const df = (this.db.prepare("SELECT count(*) AS n FROM pages_fts WHERE pages_fts MATCH ?").get(`"${t.replace(/"/g, "")}"*`) as { n: number }).n;
      weight.set(t, Math.log(1 + total / Math.max(1, df)));
    }
    const allWeight = tokens.reduce((a, t) => a + weight.get(t)!, 0);
    // A hit must contain at least half of the terms (and at least two when there are two or more), so a single
    // common word never drags in noise.
    const minMatched = Math.min(tokens.length, Math.max(2, Math.ceil(tokens.length / 2)));
    const dep = (h: { confidence: string }) => Number(h.confidence === "deprecated");
    return pool
      .map((h) => {
        const matched = matchedIn(h);
        // Coverage, weighted by rarity and squared: every term keeps the full score; missing the rarest of four
        // terms roughly halves it, missing a common one costs a few percent.
        const coverage = matched.reduce((a, t) => a + weight.get(t)!, 0) / allWeight;
        return { ...h, matched, unmatched: tokens.filter((t) => !matched.includes(t)), coverage: Math.round(coverage * 100) / 100, score: h.score * coverage * coverage };
      })
      .filter((h) => h.matched.length >= minMatched)
      // Deprecated pages come after every live page, however well they match (audit L2). bm25 is negative: lower is better.
      .sort((a, b) => dep(a) - dep(b) || a.score - b.score)
      .slice(0, limit)
      .map(({ text: _t, ...hit }) => hit);
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
    return scored.slice(0, limit).map((x) => ({ ...x.hit, score: -x.overlap, bm25: x.hit.score, boost: 1, snippet: `${x.shared}/${probe.size} tokens shared`, matched: x.matched, unmatched: [...probe].filter((t) => !x.matched.includes(t)), coverage: Math.round(x.overlap * 100) / 100 }));
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
