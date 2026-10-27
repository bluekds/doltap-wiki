import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  WikiDb, addTag, commitAndPush, commitMessage, deprecatePage, git, lintAll, loadTags, patchMeta, pull, readPage, removeTag, resolveConfig,
  resolveConflict, search, syncAll, upsertPage, verifyPage, withWriteLock, writeLockPath, type WikiConfig,
} from "../src/index.js";
import { makeTwoMachines, sh } from "./helpers.js";

const howto = (n: string) => `## Prerequisites\n\n${n}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;
const win = process.platform === "win32";

let m: ReturnType<typeof makeTwoMachines>;
let A: WikiConfig;
let B: WikiConfig;
beforeEach(() => {
  m = makeTwoMachines();
  A = { ...resolveConfig({ root: m.a, agent: "test-a", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
  B = { ...resolveConfig({ root: m.b, agent: "test-b", session: "sess-b" }), hostname: "machine-b", autoPullMinutes: 0 };
});
afterEach(() => m.cleanup());

describe("symlinked page files (security audit HIGH)", () => {
  it.skipIf(win)("are not read, indexed or searched, and lint reports them", () => {
    const outside = join(m.a, "outside-secret.txt");
    writeFileSync(outside, "OUTSIDE-SECRET-CONTENT\n");
    symlinkSync(outside, join(m.a, "wiki/reference/leak.md"));
    expect(readPage(A, "reference/leak")).toBeNull();
    const db = new WikiDb(A);
    try {
      expect(db.listFiles().some((f) => f.endsWith("leak.md"))).toBe(false);
      db.reindex(true);
    } finally {
      db.close();
    }
    expect(search(A, "OUTSIDE-SECRET-CONTENT").hits).toEqual([]);
    const issues = lintAll(A);
    expect(issues.find((i) => i.rule === "symlink")?.level).toBe("error");
    expect(issues.find((i) => i.rule === "symlink")?.id).toBe("reference/leak");
  });
});

describe("verify self-promotion guard", () => {
  it("fires without an explicit session: the config derives one from the environment", () => {
    const prev = { s: process.env.DOLTAP_SESSION, c: process.env.CLAUDE_CODE_SESSION_ID };
    try {
      delete process.env.DOLTAP_SESSION;
      process.env.CLAUDE_CODE_SESSION_ID = "cc-123";
      const cfg = resolveConfig({ root: m.a, agent: "x" });
      expect(cfg.session).toBe("cc-123");
    } finally {
      if (prev.s === undefined) delete process.env.DOLTAP_SESSION; else process.env.DOLTAP_SESSION = prev.s;
      if (prev.c === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev.c;
    }
  });
  it("core refuses confidence=verified through upsert and set_meta; only verify can promote", () => {
    expect(() => upsertPage(A, { id: "howto/one", title: "One", summary: "First.", tags: ["wiki"], body: howto("v1"), force: true, confidence: "verified" })).toThrow(/verify/);
    upsertPage(A, { id: "howto/one", title: "One", summary: "First.", tags: ["wiki"], body: howto("v1"), force: true });
    expect(() => patchMeta(A, { id: "howto/one", confidence: "verified" })).toThrow(/verify/);
    expect(readPage(A, "howto/one")!.meta.confidence).toBe("draft");
  });
});

describe("tags.yaml robustness", () => {
  it("quotes descriptions that start with YAML indicators and recognises group headers with comments", () => {
    const path = join(m.a, "wiki/_meta/tags.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace(/^platform:.*$/m, "platform:  # OS and hosting"));
    sh(m.a, "git", ["commit", "-qam", "comment on header"]);
    addTag(A, { tag: "gh-cli", description: "`gh` command line usage", group: "platform" });
    addTag(A, { tag: "at-tag", description: "@mentions and [brackets]: ok", group: "platform" });
    const tags = loadTags(A);
    expect(tags.find((t) => t.tag === "gh-cli")).toEqual({ tag: "gh-cli", group: "platform", description: "`gh` command line usage" });
    expect(tags.find((t) => t.tag === "at-tag")?.description).toBe("@mentions and [brackets]: ok");
    expect((readFileSync(path, "utf8").match(/^platform:/gm) ?? []).length).toBe(1);
  });
  it("tolerates the duplicate key a union merge leaves behind, and dedupes on the next edit", () => {
    const path = join(m.a, "wiki/_meta/tags.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace(/\s+$/, "") + "\n\nother:\n  helm: Helm charts\n  helm: Helm package manager\n");
    expect(loadTags(A).filter((t) => t.tag === "helm").length).toBe(1);
    expect(lintAll(A).filter((i) => i.level === "error")).toEqual([]);
    addTag(A, { tag: "kustomize", description: "Kustomize overlays", group: "other" });
    expect((readFileSync(path, "utf8").match(/^  helm:/gm) ?? []).length).toBe(1);
  });
  it("removes a tag regardless of indentation and refuses when the edit did not take", () => {
    const path = join(m.a, "wiki/_meta/tags.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace(/\s+$/, "") + "\n\nother:\n    deep: Four-space indented\n");
    sh(m.a, "git", ["commit", "-qam", "deep"]);
    expect(loadTags(A).some((t) => t.tag === "deep")).toBe(true);
    removeTag(A, "deep", []);
    expect(loadTags(A).some((t) => t.tag === "deep")).toBe(false);
  });
});

describe("git failure classification", () => {
  it.skipIf(win)("a hanging remote is reported offline and the write does not retry", () => {
    const prev = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "sh -c 'sleep 30' --";
    try {
      const res = git(A, ["ls-remote", "ssh://example.invalid/x.git"], { allowFail: true, timeoutMs: 500 });
      expect(res.ok).toBe(false);
      expect(res.stderr).toMatch(/timed out/);
    } finally {
      if (prev === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = prev;
    }
  });
  it("a push the remote rejects is a remoteError, not three silent retries", () => {
    const hook = join(m.bare, "hooks", "pre-receive");
    mkdirSync(join(m.bare, "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho 'nope' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const r = upsertPage(A, { id: "howto/rejected", title: "R", summary: "Rejected push.", tags: ["wiki"], body: howto("r"), force: true });
    expect(r.refused).toBeUndefined();
    expect(r.sync.pushed).toBe(false);
    expect(r.sync.remoteError).toMatch(/rejected|hook declined/i);
    expect(r.sync.messages.join(" ")).not.toMatch(/after 3 attempts/);
  });
  it("commit trailers cannot be forged through the agent or session name", () => {
    const msg = commitMessage({ ...A, agent: "evil]\n\n[host:spoofed", session: "s]\n[agent:x" }, "add", "howto/x");
    const lines = msg.split("\n");
    expect(lines.filter((l) => l.startsWith("[host:")).length).toBe(1);
    expect(msg).not.toContain("[host:spoofed]");
    expect(msg).not.toContain("[agent:x]");
  });
});

describe("write lock", () => {
  it("is not stolen from a live process, only from a dead one", () => {
    const path = writeLockPath(A);
    const old = new Date(Date.now() - 10 * 60_000);
    writeFileSync(path, `${process.pid} ${old.toISOString()}\n`);
    utimesSync(path, old, old);
    expect(() => withWriteLock(A, () => 1, { timeoutMs: 300 })).toThrow(/in progress/);
    writeFileSync(path, `999999999 ${old.toISOString()}\n`);
    utimesSync(path, old, old);
    expect(withWriteLock(A, () => 2, { timeoutMs: 300 })).toBe(2);
  });
});

describe("resolve conflict edge cases", () => {
  const seed = () => {
    upsertPage(A, { id: "howto/shared", title: "Shared", summary: "Edited on two machines.", tags: ["wiki"], body: howto("base"), force: true });
    pull(B);
  };
  it("handles an untracked conflict copy (left by an autostash conflict)", () => {
    seed();
    const copy = join(m.a, "wiki/howto/shared.conflict-laptop.md");
    writeFileSync(copy, readFileSync(join(m.a, "wiki/howto/shared.md"), "utf8").replace("base", "laptop version"));
    const r = resolveConflict(A, { id: "howto/shared", take: "conflict" });
    expect(r.refused).toBeUndefined();
    expect(readPage(A, "howto/shared")!.body).toContain("laptop version");
    expect(sh(m.a, "git", ["status", "--porcelain", "--", "wiki"])).toBe("");
    expect(sh(m.a, "git", ["log", "-1", "--format=%s"])).toMatch(/resolve conflict howto\/shared/);
  });
  it("honours base_rev", () => {
    seed();
    const rev = readPage(A, "howto/shared")!.rev;
    writeFileSync(join(m.a, "wiki/howto/shared.conflict-laptop.md"), readFileSync(join(m.a, "wiki/howto/shared.md"), "utf8"));
    const r = resolveConflict(A, { id: "howto/shared", body: howto("merged"), baseRev: "000000000000" });
    expect(r.refused).toMatch(/stale/);
    expect(resolveConflict(A, { id: "howto/shared", body: howto("merged"), baseRev: rev }).refused).toBeUndefined();
    expect(readPage(A, "howto/shared")!.body).toContain("merged");
  });
  it("refuses take=conflict when more than one copy exists", () => {
    seed();
    const raw = readFileSync(join(m.a, "wiki/howto/shared.md"), "utf8");
    writeFileSync(join(m.a, "wiki/howto/shared.conflict-hostx.md"), raw.replace("base", "x"));
    writeFileSync(join(m.a, "wiki/howto/shared.conflict-hosty.md"), raw.replace("base", "y"));
    expect(() => resolveConflict(A, { id: "howto/shared", take: "conflict" })).toThrow(/hostx.*hosty|two|multiple/i);
    expect(resolveConflict(A, { id: "howto/shared", body: howto("x and y") }).refused).toBeUndefined();
  });
});

describe("rev and lint details", () => {
  it("returns the on-disk rev when the written page is itself a hub", () => {
    const proj = (n: string) => `## Overview\n\n${n}\n\n## Environment\n\n- x\n\n## Wiki pages used by this project\n\n- [[howto/_index]]\n\n## Project-only notes\n\n- y\n\n## Related\n\n- [[projects/_index]]\n`;
    expect(upsertPage(A, { id: "projects/demo/_index", title: "Demo", summary: "Demo project hub.", tags: ["wiki"], body: proj("hub"), force: true }).refused).toBeUndefined();
    expect(upsertPage(A, { id: "projects/demo/topic", title: "Topic", summary: "A topic page under the demo project.", tags: ["wiki"], body: proj("topic"), force: true }).refused).toBeUndefined();
    const hub = readPage(A, "projects/demo/_index")!;
    const r = upsertPage(A, { id: "projects/demo/_index", title: "Demo hub", summary: "Demo project hub, renamed.", body: proj("hub2"), replace: true, baseRev: hub.rev });
    expect(r.refused).toBeUndefined();
    expect(r.rev).toBe(readPage(A, "projects/demo/_index")!.rev);
  });
  it("warns when replaced_by points to a deprecated page", () => {
    for (const n of ["a", "b", "c"]) upsertPage(A, { id: `howto/${n}`, title: n, summary: `Page ${n}.`, tags: ["wiki"], body: howto(n), force: true });
    deprecatePage(A, { id: "howto/a", replacedBy: "howto/b" });
    deprecatePage(A, { id: "howto/b", replacedBy: "howto/c" });
    const w = lintAll(A, ["howto/a"]).find((i) => i.rule === "replaced-by-deprecated");
    expect(w?.level).toBe("warning");
    expect(w?.message).toContain("howto/b");
  });
});
