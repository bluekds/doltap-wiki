import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lintAll, patchSection, readPage, refreshHubs, replaceSection, resolveConfig, upsertPage, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, sh } from "./helpers.js";

/**
 * 0.9 core audit H1 / L4: a duplicate `## Manual list` in a hub (which a patch could create) made every
 * hub-regenerating write throw and left the new page untracked; patch content may not carry a heading at
 * or above the target section's level; lint reports duplicate level-2 headings.
 */
const howto = (n: string) => `## Prerequisites\n\n${n}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;

describe("hub regeneration survives a duplicated Manual list", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "a", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
    refreshHubs(A, { pulled: false, pushed: false, conflicts: [], messages: [] });
  });
  afterEach(() => m.cleanup());

  it("upsert still succeeds and commits; the duplicate is collapsed", () => {
    const hub = join(m.a, "wiki", "howto", "_index.md");
    writeFileSync(hub, readFileSync(hub, "utf8").trimEnd() + "\n\n## Manual list\n\n- [[howto/add-wiki-page-manually]] — stray copy\n");
    sh(m.a, "git", ["commit", "-qam", "wiki: hand edit"]);
    expect(lintAll(A).find((i) => i.id === "howto/_index" && i.rule === "section-duplicate")).toMatchObject({ level: "warning" });
    const r = upsertPage(A, { id: "howto/new-one", title: "New one", summary: "New one.", tags: ["wiki"], body: howto("n"), force: true });
    expect(r.refused).toBeUndefined();
    expect(sh(m.a, "git", ["status", "--porcelain"])).toBe("");
    const page = readPage(A, "howto/_index")!;
    expect(page.sections.filter((s) => s.heading === "Manual list")).toHaveLength(1);
    expect(page.body).toContain("[[howto/new-one]]");
  });

  it("patch content cannot introduce a heading at or above the section's level", () => {
    expect(() => replaceSection("## A\n\nx\n\n## B\n\ny\n", "A", "new\n\n## B\n\nsmuggled")).toThrow(/heading/);
    expect(() => replaceSection("## A\n\nx\n", "A", "new\n\n# Top")).toThrow(/heading/);
    expect(replaceSection("## A\n\nx\n", "A", "new\n\n### Sub\n\nfine")).toContain("### Sub");
    expect(replaceSection("## A\n\nx\n", "A", "```\n## inside a fence is fine\n```")).toContain("## inside");
    expect(() => patchSection(A, { id: "howto/add-wiki-page-manually", section: "Pitfalls", content: "- p\n\n## Steps\n\n1. again" })).toThrow(/heading/);
  });
});
