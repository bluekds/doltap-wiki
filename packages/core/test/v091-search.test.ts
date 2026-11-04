import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WikiDb, assetRefsIn, audit, deprecatePage, extractLinks, normalizeMeta, splitFrontmatter, stripCode, upsertPage, type WikiConfig } from "../src/index.js";
import { cfgFor, makeWikiCopy, type Fixture } from "./helpers.js";

/**
 * 0.9.1 core audit M3, L1, L2, L7, L10, I2: the fallback keeps pages FTS matched by stem or diacritics,
 * ranking does not depend on `limit`, deprecated pages come last even when included, stats from a host that
 * stopped reading expire, fences inside list items hide their links, encoded asset names resolve, and
 * `null` / `~` placeholders in frontmatter mean absent.
 */
const howto = (body: string) => `## Prerequisites\n\n${body}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;

let fx: Fixture;
let cfg: WikiConfig;
beforeEach(() => { fx = makeWikiCopy(); cfg = cfgFor(fx.dir); });
afterEach(() => fx.cleanup());

const add = (id: string, title: string, summary: string, body: string) => upsertPage(cfg, { id, title, summary, tags: ["wiki"], body: howto(body), force: true });

describe("M3: the fallback trusts what FTS matched", () => {
  it("finds a page by inflected forms and diacritic variants of the query terms", () => {
    add("howto/containers", "Container rollout", "Rolling out containers.", "We deployed the configured containers yesterday at the café.");
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      const hits = db.search("deploying configuring containers kubernetes");
      expect(hits.map((h) => h.id)).toContain("howto/containers");
      expect(hits[0].matched).toEqual(expect.arrayContaining(["deploying", "configuring", "containers"]));
      expect(db.search("cafe containers deploying").map((h) => h.id)).toContain("howto/containers");
    } finally { db.close(); }
  });
});

describe("L1 / L2: ranking", () => {
  it("the first hit is the same whatever the limit", () => {
    add("howto/cache-one", "Cache notes", "Notes on the cache layer, verified in production.", "cache cache cache cache cache cache cache cache.");
    add("howto/cache-two", "Cache", "Cache.", "cache.");
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      const one = db.search("cache", { limit: 1 })[0].id;
      const ten = db.search("cache", { limit: 10 })[0].id;
      expect(one).toBe(ten);
    } finally { db.close(); }
  });

  it("a deprecated exact hit ranks below every live page when deprecated pages are included", () => {
    add("howto/old-rotate", "Rotate keys", "Rotate keys the old way.", "rotate keys vault");
    add("howto/new-rotate", "Rotate keys again", "Rotate keys the new way.", "rotate keys");
    deprecatePage(cfg, { id: "howto/old-rotate", replacedBy: "howto/new-rotate" });
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      // The deprecated page matches every term, the live one only two of three: the live page still comes first.
      const ids = db.search("rotate keys vault", { includeDeprecated: true }).map((h) => h.id);
      expect(ids).toContain("howto/old-rotate");
      expect(ids.indexOf("howto/old-rotate")).toBeGreaterThan(ids.indexOf("howto/new-rotate"));
      expect(ids[ids.length - 1]).toBe("howto/old-rotate");
    } finally { db.close(); }
  });
});

describe("L7: stats from a host that stopped reading", () => {
  it("counts older than the unreferenced window do not keep a page referenced", () => {
    const file = join(cfg.wikiDir, "howto", "add-wiki-page-manually.md");
    const raw = readFileSync(file, "utf8");
    writeFileSync(file, raw.replace(/^updated: .*$/m, "updated: 2024-01-01").replace(/^created: .*$/m, "created: 2024-01-01"));
    mkdirSync(join(cfg.wikiDir, "_meta", "stats"), { recursive: true });
    writeFileSync(join(cfg.wikiDir, "_meta", "stats", "old-box.json"), JSON.stringify({ host: "old-box", generated: "2025-01-01T00:00:00.000Z", windowDays: 90, counts: { "howto/add-wiki-page-manually": 3 }, lastAccess: { "howto/add-wiki-page-manually": "2025-01-01T00:00:00.000Z" } }));
    const r = audit(cfg);
    expect(r.unreferenced.map((e) => e.id)).toContain("howto/add-wiki-page-manually");
    writeFileSync(join(cfg.wikiDir, "_meta", "stats", "new-box.json"), JSON.stringify({ host: "new-box", generated: new Date().toISOString(), windowDays: 90, counts: { "howto/add-wiki-page-manually": 3 }, lastAccess: { "howto/add-wiki-page-manually": new Date().toISOString() } }));
    expect(audit(cfg).unreferenced.map((e) => e.id)).not.toContain("howto/add-wiki-page-manually");
  });
});

describe("L10 / I2: parsing edge cases", () => {
  it("a fence indented inside a list item still hides its content from link and asset extraction", () => {
    const body = "- Example:\n\n    ```md\n    [[howto/not-a-link]]\n    ![d](../_assets/howto/x/not-an-asset.png)\n    ```\n\n- Real: [[howto/_index]]\n";
    expect(extractLinks(body)).toEqual(["howto/_index"]);
    expect(stripCode(body)).not.toContain("not-a-link");
    expect(assetRefsIn(body, join(cfg.wikiDir, "howto", "x.md"), cfg.wikiDir)).toEqual([]);
  });

  it("a URL-encoded asset name resolves to the file on disk", () => {
    const refs = assetRefsIn("![s](../_assets/howto/x/my%20shot.png)", join(cfg.wikiDir, "howto", "x.md"), cfg.wikiDir);
    expect(refs).toHaveLength(1);
    expect(refs[0].rel).toBe("howto/x/my shot.png");
  });

  it("null and ~ placeholders in frontmatter mean absent", () => {
    const { data } = splitFrontmatter("---\ntitle: T\ncategory: howto\nsummary: S.\ntags: [wiki]\nconfidence: draft\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources: []\nreplaced_by: null\nreview_by: ~\nverified_on: null\nverified_by: ~\n---\nbody\n");
    const meta = normalizeMeta(data);
    expect(meta.replaced_by).toBeUndefined();
    expect(meta.review_by).toBeUndefined();
    expect(meta.verified_on).toBeUndefined();
    expect(meta.verified_by).toBeUndefined();
  });
});
