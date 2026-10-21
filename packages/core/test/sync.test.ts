import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listConflictFiles, patchSection, pull, readPage, resolveConfig, syncAll, upsertPage, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, sh } from "./helpers.js";

let m: ReturnType<typeof makeTwoMachines>;
let A: WikiConfig;
let B: WikiConfig;
beforeEach(() => {
  m = makeTwoMachines();
  A = { ...resolveConfig({ root: m.a, agent: "test-a" }), hostname: "machine-a", autoPullMinutes: 0 };
  B = { ...resolveConfig({ root: m.b, agent: "test-b" }), hostname: "machine-b", autoPullMinutes: 0 };
});
afterEach(() => m.cleanup());

const body = (n: string) => `## Problem\n\n${n}\n\n## Solution\n\n\`\`\`ts\nretry()\n\`\`\`\n\n## Variations\n\nN/A\n\n## Anti-patterns\n\n- none\n\n## Used in\n\nN/A\n\n## Related\n\n- [[patterns/_index]]\n`;

describe("multi-machine sync", () => {
  it("add on A is visible on B after pull, and the hub list is updated", () => {
    const r = upsertPage(A, { id: "patterns/retry-backoff", title: "Exponential backoff retry", summary: "Retry with jitter.", tags: ["api"], body: body("Flaky calls."), force: true });
    expect(r.refused).toBeUndefined();
    expect(r.sync.pushed).toBe(true);
    expect(sh(m.a, "git", ["log", "-1", "--format=%B"])).toContain("[host:machine-a] [agent:test-a]");
    pull(B);
    const p = readPage(B, "patterns/retry-backoff");
    expect(p?.meta.title).toBe("Exponential backoff retry");
    expect(readPage(B, "patterns/_index")?.body).toContain("- [[patterns/retry-backoff]] — Retry with jitter.");
  });

  it("refuses a near-duplicate unless forced, and lint errors abort the write", () => {
    upsertPage(A, { id: "patterns/retry-backoff", title: "Exponential backoff retry", summary: "Retry with jitter.", tags: ["api"], body: body("Flaky calls."), force: true });
    const dup = upsertPage(A, { id: "patterns/retry-with-backoff", title: "Retry with exponential backoff", summary: "Retry flaky calls with jitter.", tags: ["api"], body: body("x") });
    expect(dup.refused).toMatch(/similar/);
    expect(dup.similar?.[0].id).toBe("patterns/retry-backoff");
    expect(existsSync(join(m.a, "wiki/patterns/retry-with-backoff.md"))).toBe(false);
    const bad = upsertPage(A, { id: "patterns/other", title: "T", summary: "S", tags: ["nope"], body: body("x"), force: true });
    expect(bad.refused).toBe("lint errors");
    expect(bad.issues.map((i) => i.rule)).toContain("tag-unknown");
    expect(existsSync(join(m.a, "wiki/patterns/other.md"))).toBe(false);
  });

  it("concurrent edits to different sections merge cleanly", () => {
    upsertPage(A, { id: "patterns/retry-backoff", title: "Exponential backoff retry", summary: "Retry with jitter.", tags: ["api"], body: body("Flaky calls."), force: true });
    pull(B);
    patchSection(A, { id: "patterns/retry-backoff", section: "Variations", content: "Async version uses setTimeout." });
    const rb = patchSection(B, { id: "patterns/retry-backoff", section: "Anti-patterns", content: "- retrying non-idempotent calls" });
    expect(rb.sync.pushed).toBe(true);
    expect(rb.sync.conflicts).toEqual([]);
    pull(A);
    const p = readPage(A, "patterns/retry-backoff")!;
    expect(p.sections.find((s) => s.heading === "Variations")?.content).toBe("Async version uses setTimeout.");
    expect(p.sections.find((s) => s.heading === "Anti-patterns")?.content).toBe("- retrying non-idempotent calls");
  });

  it("concurrent edits to the same section keep upstream and save the loser as a conflict file", () => {
    upsertPage(A, { id: "patterns/retry-backoff", title: "Exponential backoff retry", summary: "Retry with jitter.", tags: ["api"], body: body("Flaky calls."), force: true });
    pull(B);
    patchSection(A, { id: "patterns/retry-backoff", section: "Problem", content: "Version from A." });
    // B edits while offline (commit only), then syncs: the rebase must conflict.
    const offline = patchSection({ ...B, noSync: true }, { id: "patterns/retry-backoff", section: "Problem", content: "Version from B." });
    expect(offline.refused).toBeUndefined();
    const rb = syncAll(B);
    expect(rb.conflicts).toEqual(["wiki/patterns/retry-backoff.conflict-machine-b.md"]);
    expect(rb.pushed).toBe(true);
    const kept = readPage(B, "patterns/retry-backoff")!;
    expect(kept.sections.find((s) => s.heading === "Problem")?.content).toBe("Version from A.");
    expect(readFileSync(join(m.b, "wiki/patterns/retry-backoff.conflict-machine-b.md"), "utf8")).toContain("Version from B.");
    expect(listConflictFiles(B)).toEqual(["wiki/patterns/retry-backoff.conflict-machine-b.md"]);
    pull(A);
    expect(existsSync(join(m.a, "wiki/patterns/retry-backoff.conflict-machine-b.md"))).toBe(true);
    expect(sh(m.a, "git", ["status", "--porcelain"])).toBe("");
  });

  it("autostash conflict on a non-wiki file takes upstream; on a page it saves a conflict copy", () => {
    // B pulls, then dirties package-lock.json and a page without committing (npm install + half-written edit).
    // Meanwhile upstream changes both. B's next pull must not get stuck.
    pull(B);
    writeFileSync(join(m.a, "package-lock.json"), "{\n  \"version\": \"upstream\"\n}\n");
    sh(m.a, "git", ["add", "package-lock.json"]);
    sh(m.a, "git", ["commit", "-q", "-m", "lock upstream"]);
    sh(m.a, "git", ["push", "-q"]);
    patchSection(A, { id: "reference/obsidian-conventions", section: "Details", content: "upstream details" });
    writeFileSync(join(m.b, "package-lock.json"), "{\n  \"version\": \"local\"\n}\n");
    const pagePath = join(m.b, "wiki/reference/obsidian-conventions.md");
    writeFileSync(pagePath, readFileSync(pagePath, "utf8").replace(/## Details\n\n[\s\S]*?\n\n## /, "## Details\n\nlocal details\n\n## "));
    const r = pull(B);
    expect(r.pulled).toBe(true);
    expect(r.messages.join(" ")).toMatch(/autostash conflicted/);
    expect(readFileSync(join(m.b, "package-lock.json"), "utf8")).toContain("upstream");
    expect(readPage(B, "reference/obsidian-conventions")?.sections.find((s) => s.heading === "Details")?.content).toBe("upstream details");
    expect(r.conflicts).toEqual(["wiki/reference/obsidian-conventions.conflict-machine-b.md"]);
    expect(readFileSync(join(m.b, "wiki/reference/obsidian-conventions.conflict-machine-b.md"), "utf8")).toContain("local details");
    expect(sh(m.b, "git", ["stash", "list"])).toBe("");
    // The tree is usable: a subsequent write goes through.
    const next = patchSection(B, { id: "reference/obsidian-conventions", section: "Details", content: "merged by hand" });
    expect(next.sync.pushed).toBe(true);
  });

  it("works offline: commit is kept locally and pushed on the next sync", () => {
    sh(m.a, "git", ["remote", "set-url", "origin", "ssh://nonexistent.invalid/x.git"]);
    const r = upsertPage(A, { id: "patterns/retry-backoff", title: "Exponential backoff retry", summary: "Retry with jitter.", tags: ["api"], body: body("Flaky calls."), force: true });
    expect(r.refused).toBeUndefined();
    expect(r.sync.offline).toBe(true);
    expect(sh(m.a, "git", ["log", "-1", "--format=%s"])).toBe("wiki: add patterns/retry-backoff");
  });
});
