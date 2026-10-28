import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WikiConfig } from "./config.js";
import { WikiDb } from "./db.js";

/**
 * A golden query: free text and the page that must come first. Wikis keep their own set in
 * wiki/_meta/golden.json and run it after ranking changes or before promoting a reworded page.
 */
export interface GoldenQuery {
  query: string;
  expect: string;
  note?: string;
}

export interface GoldenMiss extends GoldenQuery {
  /** Ids actually returned, best first (at most five). */
  got: string[];
  /** 1-based position of the expected page, or null when it was not returned at all. */
  rank: number | null;
}

export interface GoldenReport {
  file: string | null;
  total: number;
  misses: GoldenMiss[];
}

export function goldenPath(cfg: WikiConfig): string {
  return join(cfg.wikiDir, "_meta", "golden.json");
}

export function loadGolden(file: string): GoldenQuery[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${file}: expected a JSON array of {query, expect}`);
  return raw.map((e, i) => {
    const q = e as Partial<GoldenQuery>;
    if (typeof q?.query !== "string" || typeof q?.expect !== "string") throw new Error(`${file}: entry ${i} needs string "query" and "expect"`);
    return { query: q.query, expect: q.expect, note: typeof q.note === "string" ? q.note : undefined };
  });
}

/** Run every golden query against an open index; nothing is logged. */
export function checkGolden(db: WikiDb, entries: GoldenQuery[], now = Date.now()): GoldenMiss[] {
  const misses: GoldenMiss[] = [];
  for (const g of entries) {
    const got = db.search(g.query, { limit: 5, now }).map((h) => h.id);
    if (got[0] === g.expect) continue;
    const i = got.indexOf(g.expect);
    misses.push({ ...g, got, rank: i < 0 ? null : i + 1 });
  }
  return misses;
}

/** Run the wiki's own golden set (or `file`) against the current index. Missing default file: total 0. */
export function runGolden(cfg: WikiConfig, file?: string): GoldenReport {
  const path = file ?? goldenPath(cfg);
  if (!file && !existsSync(path)) return { file: null, total: 0, misses: [] };
  const entries = loadGolden(path);
  const db = new WikiDb(cfg);
  try {
    db.reindex();
    return { file: path, total: entries.length, misses: checkGolden(db, entries) };
  } finally {
    db.close();
  }
}
