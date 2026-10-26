import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CATEGORIES, isCategoryHub, type WikiConfig } from "./config.js";
import { parsePage, type Page } from "./page.js";

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
}

export interface SearchHit extends PageRow {
  score: number;
  snippet: string;
}

export interface SearchOptions {
  category?: string;
  tag?: string;
  confidence?: string;
  limit?: number;
  includeDeprecated?: boolean;
}

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
  size INTEGER NOT NULL
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
`;

const STOPWORDS = new Set(
  "the a an and or of to in on for with without from by at as is are was be this that it its into via when how what why use using used one two new set get".split(" "),
);

/** Lowercased alphanumeric tokens, length > 2, minus stopwords and category names. */
export function meaningfulTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (t.length > 2 && !STOPWORDS.has(t) && !(CATEGORIES as readonly string[]).includes(t)) out.add(t);
  }
  return out;
}

export class WikiDb {
  readonly db: DatabaseSync;
  constructor(readonly cfg: WikiConfig, path = cfg.dbPath) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Walk wiki/ for page files, skipping _meta, dotfiles, and conflict copies. */
  listFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith(".") || ent.name.startsWith("_meta")) continue;
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith(".md") && !/\.conflict-[^.]+\.md$/.test(ent.name)) out.push(p);
      }
    };
    walk(this.cfg.wikiDir);
    return out.sort();
  }

  indexPage(page: Page, mtime: number, size: number): void {
    const { meta } = page;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pages (id, rel_path, title, category, summary, tags, confidence, created, updated, mtime, size)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(page.id, page.relPath, meta.title, meta.category, meta.summary, JSON.stringify(meta.tags), meta.confidence, meta.created, meta.updated, mtime, size);
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
  reindex(full = false): { indexed: number; removed: number; total: number; pages: Page[] } {
    const files = this.listFiles();
    const known = new Map<string, { mtime: number; size: number }>();
    for (const r of this.db.prepare("SELECT id, mtime, size FROM pages").all() as { id: string; mtime: number; size: number }[]) {
      known.set(r.id, r);
    }
    const seen = new Set<string>();
    const pages: Page[] = [];
    let indexed = 0;
    const tx = this.db.prepare("BEGIN");
    tx.run();
    try {
      for (const abs of files) {
        const rel = relative(this.cfg.wikiDir, abs);
        const st = statSync(abs);
        const mtime = Math.floor(st.mtimeMs);
        const page = parsePage(this.cfg, rel, readFileSync(abs, "utf8"));
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
      return { indexed, removed, total: files.length, pages };
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

  /** Turn free text into an FTS5 query: each token becomes a prefix term, joined by implicit AND. */
  static toFtsQuery(q: string): string {
    const tokens = q
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 1);
    if (!tokens.length) return "";
    return tokens.map((t) => `"${t}"*`).join(" ");
  }

  search(query: string, o: SearchOptions = {}): SearchHit[] {
    const fts = WikiDb.toFtsQuery(query);
    if (!fts) return [];
    const limit = o.limit ?? 10;
    const where: string[] = ["pages_fts MATCH ?"];
    const args: (string | number)[] = [fts];
    if (o.category) { where.push("p.category = ?"); args.push(o.category); }
    if (o.confidence) { where.push("p.confidence = ?"); args.push(o.confidence); }
    else if (!o.includeDeprecated) where.push("p.confidence != 'deprecated'");
    // Weight title and summary and tags above body.
    const sql = `
      SELECT p.*, bm25(pages_fts, 0, 10.0, 6.0, 4.0, 1.0) AS score,
             snippet(pages_fts, 4, '**', '**', ' … ', 12) AS snippet
      FROM pages_fts JOIN pages p ON p.id = pages_fts.id
      WHERE ${where.join(" AND ")}
      ORDER BY score LIMIT ?`;
    args.push(limit * 3);
    let rows = (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      ...this.rowToPage(r),
      score: Number(r.score),
      snippet: String(r.snippet),
    }));
    if (o.tag) rows = rows.filter((p) => p.tags.includes(o.tag!));
    return rows.slice(0, limit);
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
        const shared = [...probe].filter((t) => own.has(t)).length;
        return { hit: r, shared, overlap: shared / probe.size };
      })
      .filter((x) => x.shared >= minShared && x.overlap >= minOverlap)
      .sort((a, b) => b.overlap - a.overlap);
    return scored.slice(0, limit).map((x) => ({ ...x.hit, score: -x.overlap, snippet: `${x.shared}/${probe.size} tokens shared` }));
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

  accessCounts(sinceIso: string): Map<string, number> {
    const rows = this.db.prepare("SELECT id, COUNT(*) c FROM access_log WHERE ts >= ? GROUP BY id").all(sinceIso) as { id: string; c: number }[];
    return new Map(rows.map((r) => [r.id, r.c]));
  }
}
