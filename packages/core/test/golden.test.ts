import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WikiDb } from "../src/index.js";
import { cfgFor } from "./helpers.js";

/**
 * Golden query set: each query names the page that must come first. The vault under fixtures/golden
 * is written so that naive bm25 gets several of them wrong (a routine page that mentions everything,
 * a deprecated twin, an old draft next to a verified page). Any change to ranking runs against this.
 */
interface Golden { query: string; expect: string; note?: string }
const GOLDEN_ROOT = fileURLToPath(new URL("./fixtures/golden/", import.meta.url));
const golden = JSON.parse(readFileSync(join(GOLDEN_ROOT, "golden.json"), "utf8")) as Golden[];
/** The vault's `updated` dates are fixed, so the recency boost is measured from a fixed day too. */
const NOW = Date.parse("2026-10-28T00:00:00Z");

let dir: string;
let db: WikiDb;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "doltap-golden-"));
  cpSync(join(GOLDEN_ROOT, "wiki"), join(dir, "wiki"), { recursive: true });
  db = new WikiDb(cfgFor(dir));
  db.reindex();
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("golden queries", () => {
  it("has at least twenty queries", () => expect(golden.length).toBeGreaterThanOrEqual(20));
  it("every golden query returns its page first", () => {
    const misses = golden
      .map((g) => ({ ...g, got: db.search(g.query, { limit: 5, now: NOW }).map((h) => h.id) }))
      .filter((g) => g.got[0] !== g.expect)
      .map((g) => `${JSON.stringify(g.query)} -> ${g.got.slice(0, 3).join(", ") || "(none)"} (expected ${g.expect})`);
    expect(misses).toEqual([]);
  });
  it("with the same text: verified and fresh first, then a fresh draft, then a verified page untouched for a year", () => {
    const fm = (id: string, conf: string, updated: string) =>
      `---\ntitle: Rotate the zorblat key\ncategory: howto\nsummary: How to rotate the zorblat key on the gateway.\ntags:\n  - ops\nconfidence: ${conf}\ncreated: 2026-01-01\nupdated: ${updated}\nsources: []\n---\n## Steps\n\n1. Rotate the zorblat key.\n`;
    writeFileSync(join(dir, "wiki", "howto", "zorblat-draft.md"), fm("howto/zorblat-draft", "draft", "2026-10-20"));
    writeFileSync(join(dir, "wiki", "howto", "zorblat-verified.md"), fm("howto/zorblat-verified", "verified", "2026-10-20"));
    writeFileSync(join(dir, "wiki", "howto", "zorblat-stale.md"), fm("howto/zorblat-stale", "verified", "2025-01-10"));
    db.reindex();
    const ids = db.search("rotate zorblat key", { now: NOW }).map((h) => h.id);
    expect(ids.slice(0, 3)).toEqual(["howto/zorblat-verified", "howto/zorblat-draft", "howto/zorblat-stale"]);
    const hit = db.search("rotate zorblat key", { now: NOW })[0];
    expect(hit.boost).toBeCloseTo(1.1 * 1.05 * 1.15, 5);
    expect(hit.score).toBeCloseTo(hit.bm25 * hit.boost, 5);
  });
  it("deprecated pages come last when included and are hidden by default", () => {
    const ids = db.search("openrouter key check", { includeDeprecated: true, now: NOW }).map((h) => h.id);
    expect(ids).toContain("reference/openrouter-api-legacy");
    expect(ids.indexOf("reference/openrouter-api-legacy")).toBe(ids.length - 1);
    expect(db.search("openrouter key check", { now: NOW }).map((h) => h.id)).not.toContain("reference/openrouter-api-legacy");
  });
});
