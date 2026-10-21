import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WikiDb, audit, emptyReport, get, patchMeta, publishHostStats, pull, resolveConfig, type WikiConfig } from "../src/index.js";
import { cfgFor, makeTwoMachines, makeWikiCopy, type Fixture } from "./helpers.js";

describe("audit (single machine)", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeWikiCopy(); });
  afterEach(() => fx.cleanup());

  it("classifies unreferenced, stale, lingering drafts and most-read pages", () => {
    const cfg = cfgFor(fx.dir);
    // Make one page old and unread, keep another read today.
    const old = join(cfg.wikiDir, "reference", "obsidian-conventions.md");
    writeFileSync(old, readFileSync(old, "utf8").replace(/^updated: .*$/m, "updated: 2025-01-01").replace(/^created: .*$/m, "created: 2025-01-01"));
    get(cfg, "decisions/wiki-storage-markdown-git");
    get(cfg, "decisions/wiki-storage-markdown-git");
    const r = audit(cfg);
    expect(r.unreferenced.map((e) => e.id)).toContain("reference/obsidian-conventions");
    expect(r.stale.map((e) => e.id)).toContain("reference/obsidian-conventions");
    expect(r.lingeringDrafts.map((e) => e.id)).toContain("reference/obsidian-conventions");
    expect(r.unreferenced.map((e) => e.id)).not.toContain("decisions/wiki-storage-markdown-git");
    expect(r.mostRead[0]).toMatchObject({ id: "decisions/wiki-storage-markdown-git", reads: 2 });
    expect(r.orphans).toEqual([]);
  });

  it("reports deprecated pages that are still linked", () => {
    const cfg = cfgFor(fx.dir);
    patchMeta(cfg, { id: "decisions/wiki-tooling-typescript", confidence: "deprecated" });
    const r = audit(cfg);
    expect(r.deprecatedStillLinked.map((d) => d.id)).toContain("decisions/wiki-tooling-typescript");
    expect(r.deprecatedStillLinked[0].linkedFrom).toContain("decisions/wiki-storage-markdown-git");
  });
});

describe("audit (stats shared across machines)", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  let B: WikiConfig;
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "a" }), hostname: "machine-a", autoPullMinutes: 0 };
    B = { ...resolveConfig({ root: m.b, agent: "b" }), hostname: "machine-b", autoPullMinutes: 0 };
  });
  afterEach(() => m.cleanup());

  it("reads on A count towards the audit on B after stats are published", () => {
    get(A, "reference/obsidian-conventions");
    const db = new WikiDb(A);
    const report = emptyReport();
    expect(publishHostStats(A, db, report, 0)).toBe(true);
    expect(publishHostStats(A, db, report, 0)).toBe(false); // unchanged
    db.close();
    expect(report.pushed).toBe(true);
    expect(existsSync(join(m.a, "wiki/_meta/stats/machine-a.json"))).toBe(true);
    pull(B);
    const r = audit(B, { unreferencedDays: 0 });
    expect(r.hostsReporting.sort()).toEqual(["machine-a", "machine-b"]);
    const e = r.mostRead.find((x) => x.id === "reference/obsidian-conventions");
    expect(e?.reads).toBe(1);
    expect(e?.hosts).toEqual(["machine-a"]);
  });
});
