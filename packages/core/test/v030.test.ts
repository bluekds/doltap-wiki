import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addTag, audit, deprecatePage, lintAll, loadTags, patchSection, pull, readPage, resolveConflict, resolveConfig, search, syncAll, upsertPage, verifyPage, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, sh } from "./helpers.js";

const howto = (n: string) => `## Prerequisites\n\n${n}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;

let m: ReturnType<typeof makeTwoMachines>;
let A: WikiConfig;
let B: WikiConfig;
beforeEach(() => {
  m = makeTwoMachines();
  A = { ...resolveConfig({ root: m.a, agent: "test-a", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
  B = { ...resolveConfig({ root: m.b, agent: "test-b", session: "sess-b" }), hostname: "machine-b", autoPullMinutes: 0 };
});
afterEach(() => m.cleanup());

describe("deprecate", () => {
  it("records replaced_by, adds a banner, requires an existing replacement, and shows up in search/get", () => {
    upsertPage(A, { id: "howto/old", title: "Old", summary: "Old way.", tags: ["wiki"], body: howto("old"), force: true });
    upsertPage(A, { id: "howto/new", title: "New", summary: "New way.", tags: ["wiki"], body: howto("new"), force: true });
    expect(() => deprecatePage(A, { id: "howto/old", replacedBy: "howto/missing" })).toThrow(/does not exist/);
    expect(() => deprecatePage(A, { id: "howto/old", replacedBy: "howto/old" })).toThrow(/itself/);
    const r = deprecatePage(A, { id: "howto/old", replacedBy: "howto/new", reason: "Superseded by the new flow." });
    expect(r.refused).toBeUndefined();
    const p = readPage(A, "howto/old")!;
    expect(p.meta.confidence).toBe("deprecated");
    expect(p.meta.replaced_by).toBe("howto/new");
    expect(p.body.startsWith("> **Deprecated.** Use [[howto/new]] instead. Superseded by the new flow.")).toBe(true);
    expect(p.links).toContain("howto/new");
    expect(readPage(A, "howto/_index")!.body).toContain("- [[howto/old]] — (deprecated) Old way.");
    expect(search(A, "old way", { includeDeprecated: true }).hits.find((h) => h.id === "howto/old")?.replaced_by).toBe("howto/new");
    expect(lintAll(A).filter((i) => i.id === "howto/old" && i.level === "error")).toEqual([]);
    // Deprecating by hand without a replacement is a lint error now.
    const raw = readFileSync(join(m.a, "wiki/howto/new.md"), "utf8").replace("confidence: draft", "confidence: deprecated");
    writeFileSync(join(m.a, "wiki/howto/new.md"), raw);
    expect(lintAll(A, ["howto/new"]).map((i) => i.rule)).toContain("deprecated-no-replacement");
  });
});

describe("verify", () => {
  it("needs evidence, refuses the creating session, records who verified", () => {
    upsertPage(A, { id: "howto/one", title: "One", summary: "First.", tags: ["wiki"], body: howto("v1"), force: true });
    expect(() => verifyPage(A, { id: "howto/one", evidence: "" })).toThrow(/evidence/);
    const self = verifyPage(A, { id: "howto/one", evidence: "ran it" });
    expect(self.refused).toMatch(/same session/);
    expect(readPage(A, "howto/one")!.meta.confidence).toBe("draft");
    pull(B);
    const other = verifyPage(B, { id: "howto/one", evidence: "Followed on machine-b 2026-10-27, build passed" });
    expect(other.refused).toBeUndefined();
    const p = readPage(B, "howto/one")!;
    expect(p.meta.confidence).toBe("verified");
    expect(p.meta.sources).toContain("Followed on machine-b 2026-10-27, build passed");
    expect(p.meta.verified_by).toBe("machine-b/test-b");
    expect(p.meta.verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(verifyPage(B, { id: "howto/one", evidence: "again" }).refused).toMatch(/already verified/);
  });
});

describe("resolve conflict", () => {
  it("writes the merged body, removes the conflict copies and commits", () => {
    upsertPage(A, { id: "patterns/p", title: "P", summary: "S.", tags: ["api"], body: "## Problem\n\nA\n\n## Solution\n\nx\n\n## Variations\n\nN/A\n\n## Anti-patterns\n\n- none\n\n## Used in\n\nN/A\n\n## Related\n\n- [[patterns/_index]]\n", force: true });
    pull(B);
    patchSection(A, { id: "patterns/p", section: "Problem", content: "Version from A." });
    patchSection({ ...B, noSync: true }, { id: "patterns/p", section: "Problem", content: "Version from B." });
    const rb = syncAll(B);
    expect(rb.conflicts).toEqual(["wiki/patterns/p.conflict-machine-b.md"]);
    const merged = readPage(B, "patterns/p")!.body.replace("Version from A.", "Version from A and B.");
    const r = resolveConflict(B, { id: "patterns/p", body: merged });
    expect(r.refused).toBeUndefined();
    expect(existsSync(join(m.b, "wiki/patterns/p.conflict-machine-b.md"))).toBe(false);
    expect(readPage(B, "patterns/p")!.body).toContain("Version from A and B.");
    expect(sh(m.b, "git", ["status", "--porcelain"])).toBe("");
    expect(sh(m.b, "git", ["log", "-1", "--format=%s"])).toBe("wiki: resolve conflict patterns/p");
    expect(r.sync.pushed).toBe(true);
    expect(() => resolveConflict(B, { id: "patterns/p", take: "conflict" })).toThrow(/no conflict copy/);
  });
  it("can take the conflict copy wholesale", () => {
    upsertPage(A, { id: "howto/c", title: "C", summary: "S.", tags: ["wiki"], body: howto("A"), force: true });
    pull(B);
    patchSection(A, { id: "howto/c", section: "Prerequisites", content: "from A" });
    patchSection({ ...B, noSync: true }, { id: "howto/c", section: "Prerequisites", content: "from B" });
    syncAll(B);
    const r = resolveConflict(B, { id: "howto/c", take: "conflict" });
    expect(r.refused).toBeUndefined();
    expect(readPage(B, "howto/c")!.sections[0].content).toBe("from B");
    expect(existsSync(join(m.b, "wiki/howto/c.conflict-machine-b.md"))).toBe(false);
  });
});

describe("tags", () => {
  it("adds a tag to tags.yaml keeping comments, suggests near misses, reports unused tags", () => {
    const before = readFileSync(join(m.a, "wiki/_meta/tags.yaml"), "utf8");
    expect(() => addTag(A, { tag: "Bad Tag", description: "x" })).toThrow(/kebab/);
    expect(() => addTag(A, { tag: "python", description: "x" })).toThrow(/already/);
    const r = addTag(A, { tag: "kubernetes", description: "Kubernetes clusters and manifests", group: "platform" });
    expect(r.sync.pushed).toBe(true);
    const after = readFileSync(join(m.a, "wiki/_meta/tags.yaml"), "utf8");
    expect(after.startsWith(before.split("\n").slice(0, 3).join("\n"))).toBe(true);
    expect(after).toMatch(/platform:\n(?:  .+\n)*  kubernetes: Kubernetes clusters and manifests\n/);
    expect(loadTags(A).find((t) => t.tag === "kubernetes")?.group).toBe("platform");
    const r2 = addTag(A, { tag: "terraform", description: "Terraform" });
    expect(r2.refused).toBeUndefined();
    expect(loadTags(A).find((t) => t.tag === "terraform")?.group).toBe("other");
    const bad = upsertPage(A, { id: "howto/t", title: "T", summary: "S.", tags: ["kubernete"], body: howto("x"), force: true });
    expect(bad.issues.find((i) => i.rule === "tag-unknown")?.message).toMatch(/did you mean "kubernetes"/);
    const rep = audit(A);
    expect(rep.unusedTags).toContain("terraform");
    expect(rep.unusedTags).not.toContain("wiki");
  });

  it("tags.yaml edits from two machines merge instead of one being discarded", () => {
    addTag(A, { tag: "alpha-tag", description: "A's tag" });
    addTag({ ...B, noSync: true }, { tag: "beta-tag", description: "B's tag" });
    const rb = syncAll(B);
    expect(rb.conflicts).toEqual([]);
    expect(rb.pushed).toBe(true);
    const tags = loadTags(B).map((t) => t.tag);
    expect(tags).toContain("alpha-tag");
    expect(tags).toContain("beta-tag");
    pull(A);
    expect(loadTags(A).map((t) => t.tag)).toContain("beta-tag");
  });
});

describe("git edge cases", () => {
  it("refuses to write on a detached HEAD", () => {
    sh(m.a, "git", ["checkout", "-q", "--detach"]);
    expect(() => upsertPage(A, { id: "howto/d", title: "D", summary: "S.", tags: ["wiki"], body: howto("x"), force: true })).toThrow(/detached HEAD/);
    expect(existsSync(join(m.a, "wiki/howto/d.md"))).toBe(false);
  });
  it("distinguishes a broken remote from being offline", () => {
    sh(m.a, "git", ["remote", "set-url", "origin", join(m.a, "nonexistent-remote.git")]);
    const r = upsertPage(A, { id: "howto/r", title: "R", summary: "S.", tags: ["wiki"], body: howto("x"), force: true });
    expect(r.sync.offline).toBe(false);
    expect(r.sync.remoteError).toMatch(/not appear to be a git repository|does not exist/i);
    expect(r.sync.messages.join(" ")).toMatch(/remote error/);
    expect(sh(m.a, "git", ["log", "-1", "--format=%s"])).toBe("wiki: add howto/r");
    sh(m.a, "git", ["remote", "set-url", "origin", "ssh://nonexistent.invalid/x.git"]);
    const off = upsertPage(A, { id: "howto/r2", title: "R2", summary: "S2.", tags: ["wiki"], body: howto("y"), force: true });
    expect(off.sync.offline).toBe(true);
    expect(off.sync.remoteError).toBeUndefined();
  });
});
