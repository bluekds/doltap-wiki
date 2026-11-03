import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audit, renderAuditReport, reportsDir, resolveConfig, writeAuditReport, WikiDb, type WikiConfig } from "../src/index.js";
import { cfgFor, makeTwoMachines, sh } from "./helpers.js";

/** 0.8: `doltap audit --report` keeps the weekly report in the wiki (wiki/_meta/reports/<date>.md), committed like stats. */
describe("audit report file (0.8)", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let cfg: WikiConfig;
  beforeEach(() => {
    m = makeTwoMachines();
    cfg = { ...resolveConfig({ root: m.a, noSync: true, agent: "test" }), hostname: "host-a" };
    const p = join(cfg.wikiDir, "reference/obsidian-conventions.md");
    writeFileSync(p, readFileSync(p, "utf8").replace(/^updated: .*$/m, "updated: 2026-10-19\nreview_by: 2026-01-01"));
    sh(m.a, "git", ["commit", "-qam", "backdate for the audit"]);
  });
  afterEach(() => m.cleanup());

  it("renders every audit section as markdown with the thresholds and counts", () => {
    const r = audit(cfg, { reviewDays: 7 });
    const md = renderAuditReport(r);
    expect(md).toMatch(/^# Wiki audit \d{4}-\d{2}-\d{2}/);
    for (const h of ["## Unreviewed", "## Unreferenced", "## Lingering drafts", "## Orphans", "## Deprecated but still linked", "## Conflict files", "## Unused tags", "## Most read", "## Search misses"]) expect(md).toContain(h);
    expect(md).toContain("reference/obsidian-conventions");
    expect(md).toContain("review_by 2026-01-01");
    expect(md).toMatch(/unreferenced 90 days/);
    expect(md).toMatch(/review window 7 days/);
    expect(md).toContain("Deprecate, merge and delete need a human decision");
  });

  it("writes wiki/_meta/reports/<date>.md, commits it with the host trailer, and overwrites the same day's file", () => {
    const first = writeAuditReport(cfg, audit(cfg, { reviewDays: 7 }));
    expect(first.file).toMatch(/wiki[\\/]_meta[\\/]reports[\\/]\d{4}-\d{2}-\d{2}\.md$/);
    expect(existsSync(join(cfg.root, first.file))).toBe(true);
    expect(first.removed).toEqual([]);
    const log = sh(m.a, "git", ["log", "-1", "--format=%s%n%b"]);
    expect(log).toMatch(/^wiki: audit report \d{4}-\d{2}-\d{2}/);
    expect(log).toContain("[host:host-a] [agent:test]");
    const again = writeAuditReport(cfg, audit(cfg, { reviewDays: 7 }));
    expect(again.file).toBe(first.file);
    expect(readdirSync(reportsDir(cfg))).toHaveLength(1);
    expect(sh(m.a, "git", ["status", "--porcelain"])).toBe("");
  });

  it("keeps only the newest N reports and removes the rest from git", () => {
    mkdirSync(reportsDir(cfg), { recursive: true });
    for (let i = 1; i <= 13; i++) writeFileSync(join(reportsDir(cfg), `2025-01-${String(i).padStart(2, "0")}.md`), `# Wiki audit 2025-01-${i}\n`);
    sh(m.a, "git", ["add", "-A"]); sh(m.a, "git", ["commit", "-qm", "old reports"]);
    const r = writeAuditReport(cfg, audit(cfg), { keep: 12 });
    expect(r.removed).toEqual(["2025-01-01.md", "2025-01-02.md"]);
    const left = readdirSync(reportsDir(cfg)).sort();
    expect(left).toHaveLength(12);
    expect(left[0]).toBe("2025-01-03.md");
    expect(sh(m.a, "git", ["status", "--porcelain"])).toBe("");
    expect(sh(m.a, "git", ["ls-files", "wiki/_meta/reports"])).not.toContain("2025-01-01.md");
  });

  it("reports are not pages: the index and lint ignore them", () => {
    writeAuditReport(cfg, audit(cfg));
    const db = new WikiDb(cfgFor(m.a));
    try { db.reindex(); expect(db.list({ includeDeprecated: true }).map((r) => r.id).some((id) => id.includes("reports"))).toBe(false); } finally { db.close(); }
  });
});
