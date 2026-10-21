import { WikiDb, type PageRow, type SearchHit, type SearchOptions } from "./db.js";
import { maybeAutoPull, type SyncReport } from "./git.js";
import { findSection, readPage, type Page } from "./page.js";
import type { WikiConfig } from "./config.js";

/** Read-side entry points: auto-pull if stale, incremental reindex, then query. */
function withDb<T>(cfg: WikiConfig, fn: (db: WikiDb) => T): { result: T; sync: SyncReport } {
  const sync = maybeAutoPull(cfg);
  const db = new WikiDb(cfg);
  try {
    db.reindex();
    return { result: fn(db), sync };
  } finally {
    db.close();
  }
}

export function search(cfg: WikiConfig, query: string, o: SearchOptions = {}): { hits: SearchHit[]; sync: SyncReport } {
  const { result, sync } = withDb(cfg, (db) => db.search(query, o));
  return { hits: result, sync };
}

export function list(cfg: WikiConfig, o: SearchOptions = {}): { rows: PageRow[]; sync: SyncReport } {
  const { result, sync } = withDb(cfg, (db) => db.list(o));
  return { rows: result, sync };
}

export interface GetResult {
  page: Page;
  /** Text actually returned: whole body, or just the requested section. */
  text: string;
  backlinks: string[];
}

export function get(cfg: WikiConfig, id: string, section?: string): { result: GetResult | null; sync: SyncReport } {
  return withDb(cfg, (db) => {
    const page = readPage(cfg, id);
    if (!page) return null;
    db.logAccess(id);
    let text = page.body;
    if (section) {
      const s = findSection(page.sections, section);
      if (!s) throw new Error(`section "${section}" not found in ${id}. Sections: ${page.sections.map((x) => x.heading).join(", ")}`);
      text = s.content;
    }
    return { page, text, backlinks: db.backlinks(id) };
  });
}

export interface RelatedResult {
  outlinks: PageRow[];
  backlinks: PageRow[];
  sharedTags: PageRow[];
}

export function related(cfg: WikiConfig, id: string): { result: RelatedResult; sync: SyncReport } {
  return withDb(cfg, (db) => {
    const me = db.getRow(id);
    if (!me) throw new Error(`page not found: ${id}`);
    const rows = (ids: string[]) => ids.map((i) => db.getRow(i)).filter((r): r is PageRow => !!r);
    const outlinks = rows(db.outlinks(id)).filter((r) => !r.id.endsWith("/_index"));
    const backlinks = rows(db.backlinks(id)).filter((r) => !r.id.endsWith("/_index"));
    const seen = new Set([id, ...outlinks.map((r) => r.id), ...backlinks.map((r) => r.id)]);
    const sharedTags = db
      .list()
      .filter((r) => !seen.has(r.id) && !r.id.endsWith("/_index") && r.tags.some((t) => me.tags.includes(t) && t !== "wiki"))
      .slice(0, 10);
    return { outlinks, backlinks, sharedTags };
  });
}
