import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WikiDb, lintAll, normalizeMeta, patchMeta, readPage, splitFrontmatter, upsertPage, type WikiConfig } from "../src/index.js";
import { cfgFor, makeWikiCopy, type Fixture } from "./helpers.js";

/**
 * 0.13: search hits carry how much of the query they cover (rarity-weighted) and which terms they miss, so an
 * agent can tell "the wiki has no page for this" from "this is the page"; pages can carry `aliases` (other names
 * for the subject) that search treats like the title.
 */
const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. Call the inference box on port 8004.\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";
let fx: Fixture;
let cfg: WikiConfig;
beforeEach(() => { fx = makeWikiCopy(); cfg = cfgFor(fx.dir); });
afterEach(() => fx.cleanup());

describe("coverage in search hits", () => {
  it("is 1 with nothing unmatched for a full match, below 1 with the missing terms named otherwise", () => {
    upsertPage(cfg, { id: "howto/call-inference-box", title: "Call the inference box", summary: "Ports and keys of the inference box.", tags: ["api"], body, force: true });
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      const full = db.search("call inference box")[0];
      expect(full.id).toBe("howto/call-inference-box");
      expect(full.coverage).toBe(1);
      expect(full.unmatched).toEqual([]);
      const part = db.search("call inference box kubernetes").find((h) => h.id === "howto/call-inference-box")!;
      expect(part.coverage).toBeGreaterThan(0);
      expect(part.coverage).toBeLessThan(1);
      expect(part.unmatched).toEqual(["kubernetes"]);
    } finally { db.close(); }
  });
});

describe("aliases", () => {
  it("are read from frontmatter as a list, written back after tags, and absent when empty", () => {
    const { data } = splitFrontmatter("---\ntitle: T\naliases:\n  - DGX Spark\n  - ai-server\n---\nb\n");
    expect(normalizeMeta(data).aliases).toEqual(["DGX Spark", "ai-server"]);
    expect(normalizeMeta(splitFrontmatter("---\ntitle: T\naliases: DGX Spark\n---\nb\n").data).aliases).toEqual(["DGX Spark"]);
    expect(normalizeMeta(splitFrontmatter("---\ntitle: T\naliases: []\n---\nb\n").data).aliases).toBeUndefined();
    upsertPage(cfg, { id: "howto/call-inference-box", title: "Call the inference box", summary: "Ports and keys.", tags: ["api"], aliases: ["DGX Spark", "gb10"], body, force: true });
    const raw = readFileSync(join(cfg.wikiDir, "howto", "call-inference-box.md"), "utf8");
    expect(raw.indexOf("aliases:")).toBeGreaterThan(raw.indexOf("tags:"));
    expect(raw.indexOf("aliases:")).toBeLessThan(raw.indexOf("confidence:"));
  });

  it("make a page findable by another name, ranked like a title match", () => {
    upsertPage(cfg, { id: "howto/call-inference-box", title: "Call the inference box", summary: "Ports and keys.", tags: ["api"], aliases: ["DGX Spark", "gb10"], body, force: true });
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      expect(db.search("dgx spark")[0]?.id).toBe("howto/call-inference-box");
      const hit = db.search("gb10 ports")[0];
      expect(hit.id).toBe("howto/call-inference-box");
      expect(hit.aliases).toEqual(["DGX Spark", "gb10"]);
    } finally { db.close(); }
  });

  it("set_meta replaces the list and an empty list clears it", () => {
    upsertPage(cfg, { id: "howto/call-inference-box", title: "Call the inference box", summary: "Ports and keys.", tags: ["api"], body, force: true });
    patchMeta(cfg, { id: "howto/call-inference-box", aliases: ["gb10"] });
    expect(readPage(cfg, "howto/call-inference-box")!.meta.aliases).toEqual(["gb10"]);
    patchMeta(cfg, { id: "howto/call-inference-box", aliases: [] });
    expect(readPage(cfg, "howto/call-inference-box")!.meta.aliases).toBeUndefined();
  });

  it("lint refuses empty, overlong or too many aliases", () => {
    const p = join(cfg.wikiDir, "howto", "add-wiki-page-manually.md");
    const raw = readFileSync(p, "utf8");
    const withAliases = (list: string) => raw.replace(/^tags:/m, `aliases: ${list}\ntags:`);
    writeFileSync(p, withAliases('[""]'));
    expect(lintAll(cfg).filter((i) => i.rule === "aliases-invalid")).toHaveLength(1);
    writeFileSync(p, withAliases(`["${"x".repeat(81)}"]`));
    expect(lintAll(cfg).filter((i) => i.rule === "aliases-invalid")).toHaveLength(1);
    writeFileSync(p, withAliases(`[${Array.from({ length: 21 }, (_, i) => `a${i}`).join(", ")}]`));
    expect(lintAll(cfg).filter((i) => i.rule === "aliases-invalid")).toHaveLength(1);
    writeFileSync(p, withAliases("[good, also good]"));
    expect(lintAll(cfg).filter((i) => i.rule === "aliases-invalid")).toHaveLength(0);
  });
});
