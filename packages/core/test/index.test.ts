import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WikiDb, lintAll, related, search, get, writeIndexMd } from "../src/index.js";
import { cfgFor, makeWikiCopy, type Fixture } from "./helpers.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let fx: Fixture;
beforeEach(() => { fx = makeWikiCopy(); });
afterEach(() => fx.cleanup());

describe("index and search", () => {
  it("indexes seed pages and finds them by stemmed terms", () => {
    const cfg = cfgFor(fx.dir);
    const db = new WikiDb(cfg);
    const r = db.reindex();
    expect(r.total).toBeGreaterThanOrEqual(10);
    expect(db.search("storing wiki in markdown").map((h) => h.id)).toContain("decisions/wiki-storage-markdown-git");
    expect(db.search("obsidian backlink")[0].id).toBe("reference/obsidian-conventions");
    expect(db.search("xyzzy-nothing")).toEqual([]);
    db.close();
  });

  it("reindexes incrementally and drops deleted pages", () => {
    const cfg = cfgFor(fx.dir);
    const db = new WikiDb(cfg);
    db.reindex();
    expect(db.reindex().indexed).toBe(0);
    const p = join(cfg.wikiDir, "howto", "add-wiki-page-manually.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("Add a wiki page manually", "Add a page by hand zebra"));
    const r = db.reindex();
    expect(r.indexed).toBe(1);
    expect(db.search("zebra")[0].id).toBe("howto/add-wiki-page-manually");
    db.close();
  });

  it("filters by category, tag, and hides deprecated by default", () => {
    const cfg = cfgFor(fx.dir);
    const db = new WikiDb(cfg);
    db.reindex();
    expect(db.search("wiki", { category: "decisions" }).every((h) => h.category === "decisions")).toBe(true);
    expect(db.list({ tag: "obsidian" }).map((r) => r.id)).toContain("reference/obsidian-conventions");
    const p = join(cfg.wikiDir, "reference", "obsidian-conventions.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("confidence: draft", "confidence: deprecated"));
    db.reindex();
    expect(db.search("obsidian").map((h) => h.id)).not.toContain("reference/obsidian-conventions");
    expect(db.search("obsidian", { includeDeprecated: true }).map((h) => h.id)).toContain("reference/obsidian-conventions");
    db.close();
  });

  it("duplicate detection ignores pages that only share common words", () => {
    const cfg = cfgFor(fx.dir);
    const db = new WikiDb(cfg);
    db.reindex();
    // Shares "wiki", "git", "machine" with several seed pages but is a different topic.
    expect(db.similar("Rotate the git deploy key on a machine without breaking the wiki clone. Generate a new key, update the deploy key, verify push.")).toEqual([]);
    expect(db.similar("Obsidian conventions used by this wiki: wikilinks, backlinks, Dataview, obsidian-git").map((h) => h.id)).toEqual(["reference/obsidian-conventions"]);
    db.close();
  });

  it("computes links, backlinks and related pages", () => {
    const cfg = cfgFor(fx.dir);
    const { result } = related(cfg, "decisions/wiki-storage-markdown-git");
    expect(result.outlinks.map((r) => r.id)).toContain("decisions/wiki-tooling-typescript");
    expect(result.backlinks.map((r) => r.id)).toContain("reference/obsidian-conventions");
    const g = get(cfg, "decisions/wiki-tooling-typescript", "Decision");
    expect(g.result?.text).toMatch(/^TypeScript with npm workspaces/);
    expect(() => get(cfg, "decisions/wiki-tooling-typescript", "Nope")).toThrow(/Sections:/);
  });

  it("lints seed pages clean and writes index.md", () => {
    const cfg = cfgFor(fx.dir);
    const issues = lintAll(cfg);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    const p = writeIndexMd(cfg);
    const txt = readFileSync(join(fx.dir, p), "utf8");
    expect(txt).toContain("`howto/add-wiki-page-manually` [draft]");
  });
});
