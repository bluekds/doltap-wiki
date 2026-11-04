import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { deprecatePage, patchMeta, patchSection, readPage, resolveConfig, upsertPage, verifyPage, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, sh } from "./helpers.js";

/**
 * 0.9.1 core audit M1, M5, M6, L6, L8: a write that fails before its commit leaves a clean tree; a commit takes
 * only the paths of that write; replace keeps confidence and refuses deprecated pages; the lint gate blocks only
 * errors the write introduces; set_meta cannot deprecate without a replacement; a hub's own rev is fresh.
 */
const howto = (related = "[[howto/_index]]") => `## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- ${related}\n`;

let m: ReturnType<typeof makeTwoMachines>;
let A: WikiConfig;
let A2: WikiConfig;
beforeEach(() => {
  m = makeTwoMachines();
  A = { ...resolveConfig({ root: m.a, agent: "test-a", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
  A2 = { ...A, agent: "test-a2", session: "sess-a2" };
});
afterEach(() => m.cleanup());

const hookPath = (root: string) => join(root, ".git", "hooks", "pre-commit");
const failCommits = (root: string) => { mkdirSync(join(root, ".git", "hooks"), { recursive: true }); writeFileSync(hookPath(root), "#!/bin/sh\nexit 1\n"); chmodSync(hookPath(root), 0o755); };
const allowCommits = (root: string) => rmSync(hookPath(root), { force: true });
const porcelain = (root: string) => sh(root, "git", ["status", "--porcelain"]);

describe("M1: a write whose commit fails is rolled back", () => {
  it.skipIf(platform() === "win32")("a new page is removed, the tree is clean and the retry creates it", () => {
    failCommits(m.a);
    expect(() => upsertPage(A, { id: "howto/transient", title: "T", summary: "T.", tags: ["wiki"], body: howto(), force: true })).toThrow();
    expect(existsSync(join(m.a, "wiki", "howto", "transient.md"))).toBe(false);
    expect(porcelain(m.a)).toBe("");
    allowCommits(m.a);
    const r = upsertPage(A, { id: "howto/transient", title: "T", summary: "T.", tags: ["wiki"], body: howto(), force: true });
    expect(r.refused).toBeUndefined();
    expect(r.created).toBe(true);
    expect(sh(m.a, "git", ["log", "-1", "--format=%s"])).toBe("wiki: add howto/transient");
  });

  it.skipIf(platform() === "win32")("an edited page goes back to its previous bytes, hub included", () => {
    upsertPage(A, { id: "howto/keep", title: "Keep", summary: "Keep.", tags: ["wiki"], body: howto(), force: true });
    const file = join(m.a, "wiki", "howto", "keep.md");
    const before = readFileSync(file, "utf8");
    failCommits(m.a);
    expect(() => patchSection(A, { id: "howto/keep", section: "Pitfalls", content: "- new pitfall", mode: "append" })).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(() => patchMeta(A, { id: "howto/keep", title: "Renamed" })).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(porcelain(m.a)).toBe("");
    allowCommits(m.a);
    expect(patchSection(A, { id: "howto/keep", section: "Pitfalls", content: "- new pitfall", mode: "append" }).refused).toBeUndefined();
    expect(readPage(A, "howto/keep")!.body).toContain("- new pitfall");
  });

  it("a commit takes only the paths of the write; unrelated staged files stay staged", () => {
    writeFileSync(join(m.a, "stray.txt"), "not a page\n");
    sh(m.a, "git", ["add", "stray.txt"]);
    upsertPage(A, { id: "howto/only-mine", title: "Mine", summary: "Mine.", tags: ["wiki"], body: howto(), force: true });
    const committed = sh(m.a, "git", ["show", "--name-only", "--format=", "HEAD"]).split("\n");
    expect(committed).toContain("wiki/howto/only-mine.md");
    expect(committed).not.toContain("stray.txt");
    expect(sh(m.a, "git", ["diff", "--cached", "--name-only"])).toBe("stray.txt");
  });
});

describe("M5: replace keeps confidence, refuses deprecated pages, and a demotion makes the rewriter the author", () => {
  it("a verified page rewritten without confidence stays verified", () => {
    const r = upsertPage(A, { id: "decisions/wiki-storage-markdown-git", title: "Store the wiki as Markdown + git", summary: "Rewritten.", tags: ["wiki"], body: "## Context\n\nnew\n\n## Options\n\nnew\n\n## Decision\n\nnew\n\n## Consequences\n\nnew\n\n## Related\n\n- [[decisions/_index]]\n", replace: true });
    expect(r.refused).toBeUndefined();
    const p = readPage(A, "decisions/wiki-storage-markdown-git")!;
    expect(p.meta.confidence).toBe("verified");
    expect(p.meta.summary).toBe("Rewritten.");
  });

  it("an explicit draft on a verified page clears verified_* and the rewriting session cannot verify it", () => {
    upsertPage(A, { id: "howto/one", title: "One", summary: "One.", tags: ["wiki"], body: howto(), force: true });
    expect(verifyPage(A2, { id: "howto/one", evidence: "Followed on machine-a by another session" }).refused).toBeUndefined();
    expect(readPage(A, "howto/one")!.meta.verified_on).toBeTruthy();
    const r = upsertPage(A2, { id: "howto/one", title: "One", summary: "One again.", tags: ["wiki"], body: howto(), replace: true, confidence: "draft" });
    expect(r.refused).toBeUndefined();
    const p = readPage(A, "howto/one")!;
    expect(p.meta.confidence).toBe("draft");
    expect(p.meta.verified_on).toBeUndefined();
    expect(p.meta.verified_by).toBeUndefined();
    expect(verifyPage(A2, { id: "howto/one", evidence: "Checked my own rewrite on machine-a" }).refused).toMatch(/self-promotion/);
    // The original creator wrote an earlier text of the page: still an author, still not a reviewer.
    expect(verifyPage(A, { id: "howto/one", evidence: "Checked on machine-a from the creating session" }).refused).toMatch(/self-promotion/);
    expect(verifyPage({ ...A, agent: "test-a3", session: "sess-a3" }, { id: "howto/one", evidence: "Followed the rewrite on machine-a" }).refused).toBeUndefined();
  });

  it("a deprecated page cannot be rewritten in place", () => {
    upsertPage(A, { id: "howto/old", title: "Old", summary: "Old.", tags: ["wiki"], body: howto(), force: true });
    upsertPage(A, { id: "howto/new", title: "New", summary: "New.", tags: ["wiki"], body: howto(), force: true });
    expect(deprecatePage(A, { id: "howto/old", replacedBy: "howto/new" }).refused).toBeUndefined();
    const base = readPage(A, "howto/old")!.rev;
    const r = upsertPage(A, { id: "howto/old", title: "Old", summary: "Revived.", tags: ["wiki"], body: howto(), replace: true, baseRev: base });
    expect(r.refused).toMatch(/deprecated.*howto\/new/);
    expect(readPage(A, "howto/old")!.meta.confidence).toBe("deprecated");
  });
});

describe("M6: the lint gate blocks only errors the write introduces", () => {
  const breakLink = () => {
    upsertPage(A, { id: "howto/target", title: "Target", summary: "Target.", tags: ["wiki"], body: howto(), force: true });
    upsertPage(A, { id: "howto/linker", title: "Linker", summary: "Linker.", tags: ["wiki"], body: howto("[[howto/target]]"), force: true });
    upsertPage(A, { id: "howto/other", title: "Other", summary: "Other.", tags: ["wiki"], body: howto(), force: true });
    sh(m.a, "git", ["rm", "-q", "wiki/howto/target.md"]);
    sh(m.a, "git", ["commit", "-qm", "hand: remove target"]);
  };

  it("verify, deprecate and append succeed on a page with a pre-existing broken link; the issue is still reported", () => {
    breakLink();
    const v = verifyPage(A2, { id: "howto/linker", evidence: "Followed on machine-a by another session" });
    expect(v.refused).toBeUndefined();
    expect(v.issues.some((i) => i.rule === "link-broken")).toBe(true);
    expect(readPage(A, "howto/linker")!.meta.confidence).toBe("verified");
    expect(patchSection(A, { id: "howto/linker", section: "Pitfalls", content: "- another", mode: "append" }).refused).toBeUndefined();
    expect(patchMeta(A, { id: "howto/linker", addSources: ["s"] }).refused).toBeUndefined();
    expect(deprecatePage(A, { id: "howto/linker", replacedBy: "howto/other" }).refused).toBeUndefined();
    expect(readPage(A, "howto/linker")!.meta.confidence).toBe("deprecated");
  });

  it("a new broken link in the same write is still refused", () => {
    breakLink();
    const r = patchSection(A, { id: "howto/linker", section: "Pitfalls", content: "- see [[howto/does-not-exist]]", mode: "append" });
    expect(r.refused).toBe("lint errors");
    expect(r.issues.filter((i) => i.rule === "link-broken")).toHaveLength(2);
  });
});

describe("L6 / L8: set_meta edge cases", () => {
  it("confidence deprecated through set_meta is refused (use deprecate)", () => {
    upsertPage(A, { id: "howto/x", title: "X", summary: "X.", tags: ["wiki"], body: howto(), force: true });
    expect(() => patchMeta(A, { id: "howto/x", confidence: "deprecated" })).toThrow(/deprecate/);
    expect(readPage(A, "howto/x")!.meta.confidence).toBe("draft");
  });

  it("set_meta on a hub whose list was regenerated in the same write returns the on-disk rev", () => {
    // A page added by hand without touching the hub: the next write regenerates the hub list.
    writeFileSync(join(m.a, "wiki", "howto", "by-hand.md"), `---\ntitle: By hand\ncategory: howto\nsummary: By hand.\ntags:\n  - wiki\nconfidence: draft\ncreated: 2026-11-01\nupdated: 2026-11-01\nsources: []\n---\n${howto()}`);
    sh(m.a, "git", ["add", "-A"]);
    sh(m.a, "git", ["commit", "-qm", "hand: add page"]);
    const r = patchMeta(A, { id: "howto/_index", summary: "How-to guides, renamed." });
    expect(r.refused).toBeUndefined();
    const onDisk = readPage(A, "howto/_index")!;
    expect(onDisk.body).toContain("[[howto/by-hand]]");
    expect(r.rev).toBe(onDisk.rev);
    expect(patchMeta(A, { id: "howto/_index", addSources: ["s"], baseRev: r.rev }).refused).toBeUndefined();
  });
});
