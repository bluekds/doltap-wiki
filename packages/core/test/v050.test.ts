import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WikiDb, audit, checkGolden, get, loadGolden, runGolden, search, searchMisses } from "../src/index.js";
import { cfgFor, makeWikiCopy, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => { fx = makeWikiCopy(); });
afterEach(() => fx.cleanup());

describe("search log and misses (0.5)", () => {
  it("records each search locally with the ids returned, and never in the wiki tree", () => {
    const cfg = cfgFor(fx.dir);
    const { hits } = search(cfg, "obsidian backlink");
    expect(hits[0].id).toBe("reference/obsidian-conventions");
    const db = new WikiDb(cfg);
    const log = db.searchLog("2000-01-01");
    db.close();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ agent: "test", query: "obsidian backlink" });
    expect(log[0].hits[0]).toBe("reference/obsidian-conventions");
    expect(cfg.dbPath.startsWith(cfg.stateDir)).toBe(true);
  });

  it("a read right after a search that was not the first hit is a miss; the first hit is not", () => {
    const cfg = cfgFor(fx.dir);
    const { hits } = search(cfg, "wiki");
    expect(hits.length).toBeGreaterThan(2);
    get(cfg, hits[2].id);
    search(cfg, "wiki");
    get(cfg, hits[0].id);
    search(cfg, "obsidian backlink");
    get(cfg, "howto/add-wiki-page-manually");
    const db = new WikiDb(cfg);
    const r = searchMisses(db, "2000-01-01");
    db.close();
    expect(r.count).toBe(3);
    expect(r.misses.map((m) => [m.query, m.opened, m.rank])).toEqual(expect.arrayContaining([["wiki", hits[2].id, 3]]));
    const absent = r.misses.find((m) => m.query === "obsidian backlink");
    expect(absent?.opened).toBe("howto/add-wiki-page-manually");
    expect(absent?.rank === null || absent?.rank! > 1).toBe(true);
    expect(r.misses.some((m) => m.opened === hits[0].id)).toBe(false);
    const report = audit(cfg);
    expect(report.searchCount).toBe(3);
    expect(report.searchMisses.length).toBe(r.misses.length);
  });

  it("a read by another caller or long after the search is not paired with it", () => {
    const cfg = cfgFor(fx.dir);
    search(cfg, "wiki");
    get(cfgFor(fx.dir, { agent: "other" }), "howto/add-wiki-page-manually");
    const db = new WikiDb(cfg);
    db.db.prepare("UPDATE search_log SET ts = ?").run("2026-01-01T00:00:00.000Z");
    get(cfg, "howto/add-wiki-page-manually");
    expect(searchMisses(db, "2000-01-01").misses).toEqual([]);
    db.close();
  });
});

describe("golden set runner (0.5)", () => {
  it("runs wiki/_meta/golden.json by default and reports misses with rank", () => {
    const cfg = cfgFor(fx.dir);
    expect(runGolden(cfg)).toEqual({ file: null, total: 0, misses: [] });
    mkdirSync(join(cfg.wikiDir, "_meta"), { recursive: true });
    const file = join(cfg.wikiDir, "_meta", "golden.json");
    writeFileSync(file, JSON.stringify([
      { query: "obsidian backlink", expect: "reference/obsidian-conventions" },
      { query: "obsidian backlink", expect: "howto/add-wiki-page-manually", note: "wrong on purpose" },
      { query: "xyzzy-nothing", expect: "Home" },
    ]));
    const r = runGolden(cfg);
    expect(r.file).toBe(file);
    expect(r.total).toBe(3);
    expect(r.misses.map((m) => m.expect)).toEqual(["howto/add-wiki-page-manually", "Home"]);
    expect(r.misses[0].rank === null || r.misses[0].rank > 1).toBe(true);
    expect(r.misses[1]).toMatchObject({ rank: null, got: [] });
    expect(r.misses[0].note).toBe("wrong on purpose");
    // Running the golden set does not pollute the search log.
    const db = new WikiDb(cfg);
    expect(db.searchLog("2000-01-01")).toEqual([]);
    expect(checkGolden(db, [{ query: "obsidian backlink", expect: "reference/obsidian-conventions" }])).toEqual([]);
    db.close();
  });

  it("rejects a malformed golden file", () => {
    const file = join(fx.dir, "bad.json");
    writeFileSync(file, JSON.stringify({ query: "x" }));
    expect(() => loadGolden(file)).toThrow(/JSON array/);
    writeFileSync(file, JSON.stringify([{ query: "x" }]));
    expect(() => loadGolden(file)).toThrow(/entry 0/);
  });
});
