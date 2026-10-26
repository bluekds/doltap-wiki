import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WikiDb, get, lintAll, parsePage, patchMeta, patchSection, pull, readPage, refreshHubs, replaceSection, resolveConfig, search, upsertPage, type WikiConfig } from "../src/index.js";
import { cfgFor, makeTwoMachines, makeWikiCopy, sh, type Fixture } from "./helpers.js";

const howto = (n: string) => `## Prerequisites\n\n${n}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;

describe("optimistic concurrency", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  let B: WikiConfig;
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "test-a" }), hostname: "machine-a", autoPullMinutes: 0 };
    B = { ...resolveConfig({ root: m.b, agent: "test-b" }), hostname: "machine-b", autoPullMinutes: 0 };
  });
  afterEach(() => m.cleanup());

  it("refuses to overwrite an existing id unless replace is set, and checks base_rev", () => {
    const first = upsertPage(A, { id: "howto/one", title: "One", summary: "First.", tags: ["wiki"], body: howto("v1"), force: true });
    expect(first.refused).toBeUndefined();
    expect(first.rev).toMatch(/^[0-9a-f]{12}$/);
    const again = upsertPage(A, { id: "howto/one", title: "Other", summary: "Else.", tags: ["wiki"], body: howto("v2"), force: true });
    expect(again.refused).toMatch(/exists/);
    expect(readPage(A, "howto/one")!.meta.title).toBe("One");
    const stale = upsertPage(A, { id: "howto/one", title: "Other", summary: "Else.", tags: ["wiki"], body: howto("v2"), replace: true, baseRev: "000000000000" });
    expect(stale.refused).toMatch(/stale/);
    expect(readPage(A, "howto/one")!.meta.title).toBe("One");
    const { result } = get(A, "howto/one");
    expect(result!.page.rev).toBe(first.rev);
    const ok = upsertPage(A, { id: "howto/one", title: "Other", summary: "Else.", tags: ["wiki"], body: howto("v2"), replace: true, baseRev: result!.page.rev });
    expect(ok.refused).toBeUndefined();
    expect(ok.created).toBe(false);
    expect(readPage(A, "howto/one")!.meta.title).toBe("Other");
    expect(readPage(A, "howto/one")!.rev).toBe(ok.rev);
    const p = patchSection(A, { id: "howto/one", section: "Pitfalls", content: "- p", baseRev: first.rev });
    expect(p.refused).toMatch(/stale/);
    const mp = patchMeta(A, { id: "howto/one", summary: "New summary.", baseRev: first.rev });
    expect(mp.refused).toMatch(/stale/);
  });

  it("a stale replace from another machine is refused instead of silently dropping the other edit", () => {
    upsertPage(A, { id: "howto/one", title: "One", summary: "First.", tags: ["wiki"], body: howto("v1"), force: true });
    pull(B);
    const seenByB = readPage(B, "howto/one")!.rev;
    patchSection(A, { id: "howto/one", section: "Pitfalls", content: "- A-ONLY pitfall" });
    const r = upsertPage(B, { id: "howto/one", title: "One", summary: "First.", tags: ["wiki"], body: howto("v1 rewritten by B"), replace: true, baseRev: seenByB });
    expect(r.refused).toMatch(/stale/);
    expect(readPage(B, "howto/one")!.body).toContain("A-ONLY");
  });
});

describe("search", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeWikiCopy(); });
  afterEach(() => fx.cleanup());

  it("drops stopwords, keeps non-ASCII tokens", () => {
    expect(WikiDb.toFtsQuery("fix the sync when push rejected")).toBe('"fix"* "sync"* "push"* "rejected"*');
    expect(WikiDb.toFtsQuery("위키 설치")).toBe('"위키"* "설치"*');
    expect(WikiDb.toFtsQuery("the a")).toBe('"the"*');
    expect(WikiDb.toFtsQuery("deploy")).toBe('"deploy"*');
  });

  it("falls back to OR when no page matches every term, ranking full matches first", () => {
    const cfg = cfgFor(fx.dir);
    const none = search(cfg, "obsidian conventions kubernetes").hits;
    expect(none.map((h) => h.id)).toContain("reference/obsidian-conventions");
    expect(none[0].matched).toEqual(expect.arrayContaining(["obsidian", "conventions"]));
    const both = search(cfg, "obsidian wiki").hits;
    expect(both[0].id).toBe("reference/obsidian-conventions");
  });

  it("excludes category hubs unless asked", () => {
    const cfg = cfgFor(fx.dir);
    expect(search(cfg, "hub category").hits.map((h) => h.id).filter((id) => id.endsWith("/_index"))).toEqual([]);
    expect(search(cfg, "hub category", { includeHubs: true }).hits.some((h) => h.id.endsWith("/_index"))).toBe(true);
  });
});

describe("fault-tolerant reindex and frontmatter", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeWikiCopy(); });
  afterEach(() => fx.cleanup());

  it("one malformed page is reported, not fatal", () => {
    const cfg = cfgFor(fx.dir);
    writeFileSync(join(fx.dir, "wiki", "howto", "broken.md"), "---\ntitle: Bad: colon page\ncategory: howto\n---\n\n## Steps\n\nx\n");
    expect(search(cfg, "obsidian").hits.length).toBeGreaterThan(0);
    const issues = lintAll(cfg);
    const bad = issues.find((i) => i.rule === "frontmatter-invalid");
    expect(bad?.id).toBe("howto/broken");
    expect(bad?.level).toBe("error");
    expect(() => readPage(cfg, "howto/broken")).toThrow(/howto\/broken/);
    const db = new WikiDb(cfg);
    expect(db.reindex().broken.map((b) => b.id)).toEqual(["howto/broken"]);
    db.close();
  });

  it("keeps numeric-looking strings and tolerates a BOM", () => {
    const cfg = cfgFor(fx.dir);
    const raw = "﻿---\ntitle: 1.10\ncategory: howto\nsummary: 0x1F\ntags: [wiki]\nconfidence: draft\ncreated: 2026-10-18\nupdated: 2026-10-18\nsources: []\n---\n\n" + howto("x");
    const page = parsePage(cfg, "howto/num.md", raw);
    expect(page.meta.title).toBe("1.10");
    expect(page.meta.summary).toBe("0x1F");
    expect(page.meta.created).toBe("2026-10-18");
    writeFileSync(join(fx.dir, "wiki", "howto", "num.md"), raw);
    sh(fx.dir, "git", ["init", "-q"]);
    const r = patchSection(cfg, { id: "howto/num", section: "Pitfalls", content: "- y" });
    expect(r.refused).toBeUndefined();
    const after = readPage(cfg, "howto/num")!;
    expect(after.meta.title).toBe("1.10");
    expect(after.meta.summary).toBe("0x1F");
    expect(after.raw.startsWith("---")).toBe(true);
  });
});

describe("hub lists are derived from the index", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "test-a" }), hostname: "machine-a", autoPullMinutes: 0 };
  });
  afterEach(() => m.cleanup());

  it("summary changes and deprecation show up in the hub; a hand-damaged list is restored on sync", () => {
    upsertPage(A, { id: "howto/one", title: "One", summary: "First.", tags: ["wiki"], body: howto("v1"), force: true });
    expect(readPage(A, "howto/_index")!.body).toContain("- [[howto/one]] — First.");
    patchMeta(A, { id: "howto/one", summary: "Changed." });
    const hub1 = readPage(A, "howto/_index")!.body;
    expect(hub1).toContain("- [[howto/one]] — Changed.");
    expect(hub1).not.toContain("First.");
    patchMeta(A, { id: "howto/one", confidence: "deprecated" });
    expect(readPage(A, "howto/_index")!.body).toContain("- [[howto/one]] — (deprecated) Changed.");
    const hubPath = join(m.a, "wiki/howto/_index.md");
    writeFileSync(hubPath, readFileSync(hubPath, "utf8").replace(/- \[\[howto\/one\]\][^\n]*\n/, ""));
    expect(readPage(A, "howto/_index")!.body).not.toContain("[[howto/one]]");
    const changed = refreshHubs(A);
    expect(changed).toEqual(["wiki/howto/_index.md"]);
    expect(readPage(A, "howto/_index")!.body).toContain("- [[howto/one]] — (deprecated) Changed.");
    expect(sh(m.a, "git", ["status", "--porcelain"])).toBe("");
    expect(refreshHubs(A)).toEqual([]);
  });
});

describe("patch_section targeting", () => {
  const body = "## Steps\n\n1. run\n\n### Verification\n\ninner check\n\n```py\nprint(1)\n\nprint(2)\n```\n\n## Verification\n\nouter check\n\n## Related\n\n- [[howto/_index]]\n";
  it("prefers the ## heading over a ### with the same name and leaves the rest byte-identical", () => {
    const out = replaceSection(body, "Verification", "    indented\nnew outer");
    expect(out).toContain("### Verification\n\ninner check");
    expect(out).toContain("print(1)\n\nprint(2)");
    expect(out).toContain("## Verification\n\n    indented\nnew outer\n\n## Related");
    expect(out).not.toContain("outer check");
  });
  it("refuses an unknown heading unless create is set, and reports ambiguity", () => {
    expect(() => replaceSection(body, "Pitfall", "x")).toThrow(/not found.*Steps, Verification, Verification, Related/);
    expect(replaceSection(body, "Pitfall", "x", "replace", { create: true })).toContain("\n## Pitfall\n\nx\n");
    const dup = "## Notes\n\na\n\n## Notes\n\nb\n";
    expect(() => replaceSection(dup, "Notes", "x")).toThrow(/ambiguous/);
  });
  it("patchSection surfaces the same rules", () => {
    const fx = makeWikiCopy();
    try {
      sh(fx.dir, "git", ["init", "-q"]);
      const cfg = cfgFor(fx.dir);
      expect(() => patchSection(cfg, { id: "howto/add-wiki-page-manually", section: "Pitfall", content: "x" })).toThrow(/not found/);
      const r = patchSection(cfg, { id: "howto/add-wiki-page-manually", section: "Pitfall", content: "x", create: true });
      expect(r.refused).toBeUndefined();
      expect(readPage(cfg, "howto/add-wiki-page-manually")!.sections.map((s) => s.heading)).toContain("Pitfall");
    } finally { fx.cleanup(); }
  });
});
