import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WikiDb, search } from "../src/index.js";
import { cfgFor, makeWikiCopy, type Fixture } from "./helpers.js";

/**
 * 0.9 no-op reindex: a request only stats the page files; unchanged pages (same mtime and size as the
 * indexed row) are neither read nor parsed. Callers that need every parsed page ask for them.
 */
describe("incremental reindex reads only changed files", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeWikiCopy(); });
  afterEach(() => fx.cleanup());

  /**
   * Break a page's frontmatter without changing its size, then put the mtime back (whole milliseconds:
   * Node rounds `stat().mtime` to a Date while the index floors `mtimeMs`), so only a parse would notice.
   */
  const corruptInPlace = (file: string) => {
    const st = statSync(file);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("\ntitle: ");
    writeFileSync(file, raw.replace("\ntitle: ", "\nti: t: "));
    const whole = new Date(Math.floor(st.mtimeMs));
    utimesSync(file, whole, whole);
    expect(statSync(file).size).toBe(st.size);
  };

  it("an unchanged page is not parsed; pages come back only when asked for", () => {
    const cfg = cfgFor(fx.dir);
    const db = new WikiDb(cfg);
    try {
      const first = db.reindex();
      expect(first.indexed).toBe(first.total);
      expect(first.pages).toBeUndefined();
      const file = join(cfg.wikiDir, "howto", "setup-wiki-on-new-machine.md");
      corruptInPlace(file);
      const noop = db.reindex();
      expect(noop.indexed).toBe(0);
      expect(noop.removed).toBe(0);
      expect(noop.broken).toEqual([]);
      expect(db.getRow("howto/setup-wiki-on-new-machine")?.title).toBeTruthy();
      // Asking for the pages parses every file, and the corrupted one shows up as broken.
      const withPages = db.reindex(false, { pages: true });
      expect(withPages.pages.map((p) => p.id)).not.toContain("howto/setup-wiki-on-new-machine");
      expect(withPages.broken.map((b) => b.id)).toEqual(["howto/setup-wiki-on-new-machine"]);
      expect(withPages.pages.length).toBe(withPages.total);
      expect(db.getRow("howto/setup-wiki-on-new-machine")).toBeNull();
    } finally { db.close(); }
  });

  it("a changed file is re-parsed and a broken page is reported on every call until fixed", () => {
    const cfg = cfgFor(fx.dir);
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      const file = join(cfg.wikiDir, "howto", "add-wiki-page-manually.md");
      const raw = readFileSync(file, "utf8");
      const later = new Date(Date.now() + 5000);
      writeFileSync(file, raw.replace(/^title: .*$/m, "title: Renamed page"));
      utimesSync(file, later, later);
      expect(db.reindex().indexed).toBe(1);
      expect(db.getRow("howto/add-wiki-page-manually")?.title).toBe("Renamed page");
      writeFileSync(join(cfg.wikiDir, "howto", "broken.md"), "---\ntitle: Bad: colon page\ncategory: howto\n---\n\n## Steps\n\nx\n");
      expect(db.reindex().broken.map((b) => b.id)).toEqual(["howto/broken"]);
      expect(db.reindex().broken.map((b) => b.id)).toEqual(["howto/broken"]);
      // A full reindex re-parses everything whether or not pages are requested.
      const full = db.reindex(true);
      expect(full.indexed).toBe(full.total);
      expect(full.pages).toBeUndefined();
    } finally { db.close(); }
  });

  it("search still sees edits made through the file system", () => {
    const cfg = cfgFor(fx.dir);
    expect(search(cfg, "zebra-unique-term").hits).toHaveLength(0);
    const file = join(cfg.wikiDir, "howto", "add-wiki-page-manually.md");
    const later = new Date(Date.now() + 5000);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^summary: (.*)$/m, "summary: $1 zebra-unique-term"));
    utimesSync(file, later, later);
    expect(search(cfg, "zebra-unique-term").hits.map((h) => h.id)).toEqual(["howto/add-wiki-page-manually"]);
  });
});
