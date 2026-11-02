import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DURABLE_CATEGORIES, REVIEW_DEFAULT_DAYS, WikiDb, audit, lintAll, patchMeta, readPage, recencyBoost, resolveConfig, reviewByFrom, syncAll, upsertPage, verifyPage,
  type WikiConfig,
} from "../src/index.js";
import { cfgFor, makeTwoMachines, makeWikiCopy, sh, type Fixture } from "./helpers.js";

/**
 * 0.7 content lifecycle: validity follows what a page depends on, not calendar time.
 * decisions/ and projects/ never expire by age; howto/ and reference/ carry an author-set `review_by`;
 * ranking no longer penalises age; audit lists "unreviewed" (review_by passed or category default exceeded)
 * instead of "stale"; re-verifying an unchanged page moves verified_on / review_by without editing the body.
 */
const NOW = Date.parse("2026-11-02T00:00:00Z");
const DAY = 86400000;
const howto = (n: string) => `## Prerequisites\n\n${n}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;

describe("recency is a small bonus for new or recently verified pages, never a penalty", () => {
  it("keys on verified_on when present, else created; durable categories get no boost at all", () => {
    const fresh = new Date(NOW - 10 * DAY).toISOString().slice(0, 10);
    const old = "2024-01-01";
    expect(recencyBoost({ category: "howto", created: fresh, verified_on: null }, NOW)).toBeCloseTo(1.05, 5);
    expect(recencyBoost({ category: "howto", created: old, verified_on: fresh }, NOW)).toBeCloseTo(1.05, 5);
    expect(recencyBoost({ category: "howto", created: old, verified_on: old }, NOW)).toBe(1.0);
    expect(recencyBoost({ category: "reference", created: old, verified_on: null }, NOW)).toBe(1.0);
    // A decision made last week is not "more relevant" than one made last year.
    expect(recencyBoost({ category: "decisions", created: fresh, verified_on: fresh }, NOW)).toBe(1.0);
    expect(DURABLE_CATEGORIES).toEqual(["decisions", "projects"]);
    expect(REVIEW_DEFAULT_DAYS).toEqual({ reference: 180, howto: 365 });
  });
});

describe("review_by in frontmatter", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeWikiCopy(); });
  afterEach(() => fx.cleanup());

  const setMeta = (cfg: WikiConfig, rel: string, patch: (raw: string) => string) => {
    const p = join(cfg.wikiDir, rel);
    writeFileSync(p, patch(readFileSync(p, "utf8")));
  };

  it("reviewByFrom accepts a day count, a date or none", () => {
    expect(reviewByFrom("60", "2026-11-02")).toBe("2027-01-01");
    expect(reviewByFrom("2027-03-01", "2026-11-02")).toBe("2027-03-01");
    expect(reviewByFrom("none", "2026-11-02")).toBeNull();
    expect(reviewByFrom("", "2026-11-02")).toBeNull();
    expect(() => reviewByFrom("soon", "2026-11-02")).toThrow(/review_by/);
    expect(() => reviewByFrom("0", "2026-11-02")).toThrow(/review_by/);
  });

  it("lint warns when review_by has passed and errors when it is not a date", () => {
    const cfg = cfgFor(fx.dir);
    setMeta(cfg, "reference/obsidian-conventions.md", (raw) => raw.replace(/^updated: .*$/m, "updated: 2026-10-19\nreview_by: 2026-01-01"));
    setMeta(cfg, "howto/setup-wiki-on-new-machine.md", (raw) => raw.replace(/^updated: .*$/m, "updated: 2026-10-18\nreview_by: soon"));
    const issues = lintAll(cfg);
    expect(issues.find((i) => i.id === "reference/obsidian-conventions" && i.rule === "review-due")).toMatchObject({ level: "warning" });
    expect(issues.find((i) => i.id === "howto/setup-wiki-on-new-machine" && i.rule === "review-by-invalid")).toMatchObject({ level: "error" });
    // An empty placeholder (from the template) is simply "not set".
    setMeta(cfg, "howto/setup-wiki-on-new-machine.md", (raw) => raw.replace(/^review_by: soon$/m, "review_by:"));
    expect(lintAll(cfg).filter((i) => i.rule.startsWith("review"))).toHaveLength(1);
    expect(readPage(cfg, "howto/setup-wiki-on-new-machine")!.meta.review_by).toBeUndefined();
  });

  it("the index carries review_by and verified_on", () => {
    const cfg = cfgFor(fx.dir);
    setMeta(cfg, "reference/obsidian-conventions.md", (raw) => raw.replace(/^updated: .*$/m, "updated: 2026-10-19\nreview_by: 2027-01-01\nverified_on: 2026-10-20"));
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      expect(db.getRow("reference/obsidian-conventions")).toMatchObject({ review_by: "2027-01-01", verified_on: "2026-10-20" });
      expect(db.getRow("howto/setup-wiki-on-new-machine")).toMatchObject({ review_by: null, verified_on: null });
    } finally { db.close(); }
  });

  it("audit lists unreviewed volatile pages and leaves durable pages alone however old they are", () => {
    const cfg = cfgFor(fx.dir);
    // reference page: review_by passed.
    setMeta(cfg, "reference/obsidian-conventions.md", (raw) => raw.replace(/^updated: .*$/m, "updated: 2026-10-19\nreview_by: 2026-01-01"));
    // howto page without review_by, last touched longer ago than the howto default.
    setMeta(cfg, "howto/setup-wiki-on-new-machine.md", (raw) => raw.replace(/^updated: .*$/m, "updated: 2024-01-01").replace(/^created: .*$/m, "created: 2024-01-01"));
    // a decision from long ago, never read.
    setMeta(cfg, "decisions/wiki-storage-markdown-git.md", (raw) => raw.replace(/^updated: .*$/m, "updated: 2023-01-01").replace(/^created: .*$/m, "created: 2023-01-01"));
    const r = audit(cfg);
    expect(r).not.toHaveProperty("stale");
    const unreviewed = r.unreviewed.map((e) => e.id);
    expect(unreviewed).toContain("reference/obsidian-conventions");
    expect(unreviewed).toContain("howto/setup-wiki-on-new-machine");
    expect(unreviewed).not.toContain("decisions/wiki-storage-markdown-git");
    expect(r.unreviewed.find((e) => e.id === "reference/obsidian-conventions")).toMatchObject({ reviewBy: "2026-01-01" });
    expect(r.unreferenced.map((e) => e.id)).not.toContain("decisions/wiki-storage-markdown-git");
    expect(r.unreferenced.map((e) => e.id)).toContain("howto/setup-wiki-on-new-machine");
    // A review_by in the future keeps an old page out of the list, whatever its updated date.
    setMeta(cfg, "howto/setup-wiki-on-new-machine.md", (raw) => raw.replace(/^updated: .*$/m, "updated: 2024-01-01\nreview_by: 2099-01-01"));
    expect(audit(cfg).unreviewed.map((e) => e.id)).not.toContain("howto/setup-wiki-on-new-machine");
    // --review-days overrides the category defaults.
    expect(audit(cfg, { reviewDays: 7 }).unreviewed.map((e) => e.id)).toContain("howto/add-wiki-page-manually");
    expect(audit(cfg, { reviewDays: 7 }).thresholds.reviewDays).toBe(7);
  });
});

describe("verify and re-verify", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  let B: WikiConfig;
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "test-a", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
    B = { ...resolveConfig({ root: m.b, agent: "test-b", session: "sess-b" }), hostname: "machine-b", autoPullMinutes: 0 };
  });
  afterEach(() => m.cleanup());

  it("promotion can set review_by; re-verifying a verified page moves verified_on and review_by but not updated", () => {
    upsertPage(A, { id: "howto/one", title: "One", summary: "One thing.", tags: ["wiki"], body: howto("one"), force: true });
    syncAll(B);
    const v = verifyPage(B, { id: "howto/one", evidence: "Followed on machine-b 2026-11-02, build passed", reviewBy: "60" });
    expect(v.refused).toBeUndefined();
    let p = readPage(B, "howto/one")!;
    expect(p.meta.confidence).toBe("verified");
    const firstVerifiedOn = String(p.meta.verified_on);
    expect(p.meta.review_by).toBe(reviewByFrom("60", firstVerifiedOn));
    const updatedBefore = p.meta.updated;
    const bodyBefore = p.body;
    // Backdate the record as if a season passed, then re-verify from the creating session: allowed, this is not promotion.
    const file = join(B.wikiDir, "howto", "one.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^verified_on: .*$/m, "verified_on: 2026-06-01").replace(/^review_by: .*$/m, "review_by: 2026-08-01").replace(/^updated: .*$/m, "updated: 2026-06-01"));
    sh(m.b, "git", ["commit", "-qam", "backdate"]);
    syncAll(B);
    syncAll(A);
    const again = verifyPage(A, { id: "howto/one", evidence: "Re-checked on machine-a 2026-11-02; steps unchanged" });
    expect(again.refused).toBeUndefined();
    p = readPage(A, "howto/one")!;
    expect(p.meta.confidence).toBe("verified");
    expect(String(p.meta.verified_on)).not.toBe("2026-06-01");
    expect(String(p.meta.verified_by)).toBe("machine-a/test-a");
    // Interval kept: review_by was 61 days after verified_on, so the new one is 61 days after today's verified_on.
    expect(p.meta.review_by).toBe(reviewByFrom("61", String(p.meta.verified_on)));
    expect(p.meta.updated).toBe("2026-06-01");
    expect(p.body).toBe(bodyBefore);
    expect(p.meta.sources).toContain("Re-checked on machine-a 2026-11-02; steps unchanged");
    expect(updatedBefore).not.toBe("2026-06-01");
    // An explicit review_by of none clears it.
    verifyPage(A, { id: "howto/one", evidence: "Re-checked once more on machine-a; stable procedure", reviewBy: "none" });
    expect(readPage(A, "howto/one")!.meta.review_by).toBeUndefined();
  });

  it("set_meta and upsert accept review_by; none clears it", () => {
    const r = upsertPage(A, { id: "reference/thing", title: "Thing", summary: "Facts about thing.", tags: ["wiki"], body: "## Key facts\n\n- x\n\n## Details\n\ny\n\n## Verified on\n\n2026-11-02\n\n## Related\n\n- [[reference/_index]]\n", force: true, reviewBy: "2027-01-01" });
    expect(r.refused).toBeUndefined();
    expect(readPage(A, "reference/thing")!.meta.review_by).toBe("2027-01-01");
    patchMeta(A, { id: "reference/thing", reviewBy: "none" });
    expect(readPage(A, "reference/thing")!.meta.review_by).toBeUndefined();
    patchMeta(A, { id: "reference/thing", reviewBy: "30" });
    expect(readPage(A, "reference/thing")!.meta.review_by).toBe(reviewByFrom("30", readPage(A, "reference/thing")!.meta.updated));
    expect(() => patchMeta(A, { id: "reference/thing", reviewBy: "whenever" })).toThrow(/review_by/);
  });
});
