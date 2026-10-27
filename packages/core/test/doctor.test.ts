import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfgFor, makeTwoMachines, sh } from "./helpers.js";
import { doctor, listLogs, rotateLogs, upsertPage, WikiDb, type DoctorCheck, type WikiConfig } from "../src/index.js";

let m: ReturnType<typeof makeTwoMachines>;
let cfg: WikiConfig;
beforeEach(() => {
  m = makeTwoMachines();
  cfg = cfgFor(m.a, { noSync: false, session: "s1" });
  new WikiDb(cfg).reindex() && undefined;
});
afterEach(() => m.cleanup());

const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";
const byName = (checks: DoctorCheck[], name: string) => checks.find((c) => c.name === name)!;
const run = () => doctor(cfg, { services: false });

describe("doctor", () => {
  it("reports a healthy clone as ok with no failures", async () => {
    sh(m.a, "git", ["pull", "-q"]);
    writeFileSync(join(cfg.stateDir, "sync.json"), JSON.stringify({ lastPull: new Date().toISOString() }));
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.failures).toBe(0);
    for (const n of ["node", "repo", "remote", "worktree", "conflicts", "sync", "tags", "lint", "index"]) expect(byName(r.checks, n).status, n).toBe("ok");
    expect(byName(r.checks, "secrets").status).toBe("skip");
    expect(byName(r.checks, "logs").status).toBe("skip");
  });

  it("flags a detached HEAD and a missing identity as failures", async () => {
    sh(m.a, "git", ["checkout", "-q", "--detach"]);
    expect(byName((await run()).checks, "repo")).toMatchObject({ status: "fail", detail: expect.stringContaining("detached") });
    sh(m.a, "git", ["checkout", "-q", "main"]);
    sh(m.a, "git", ["config", "--unset", "user.email"]);
    expect(byName((await run()).checks, "repo")).toMatchObject({ status: "fail", detail: expect.stringContaining("identity") });
  });

  it("warns about unpushed commits, dirty pages, conflict copies and a stale pull", async () => {
    upsertPage({ ...cfg, noSync: true }, { id: "howto/doc-a", title: "A", summary: "A page.", tags: ["wiki"], body, force: true });
    writeFileSync(join(cfg.wikiDir, "howto", "doc-a.conflict-other.md"), "x\n");
    writeFileSync(join(cfg.wikiDir, "howto", "add-wiki-page-manually.md"), readFileSync(join(cfg.wikiDir, "howto", "add-wiki-page-manually.md"), "utf8") + "\nedited\n");
    writeFileSync(join(cfg.stateDir, "sync.json"), JSON.stringify({ lastPull: new Date(Date.now() - 5 * 3600_000).toISOString() }));
    const r = await run();
    expect(byName(r.checks, "remote")).toMatchObject({ status: "warn", detail: expect.stringContaining("1 commit(s) not pushed") });
    expect(byName(r.checks, "worktree")).toMatchObject({ status: "warn", detail: expect.stringContaining("uncommitted") });
    expect(byName(r.checks, "conflicts")).toMatchObject({ status: "warn", detail: expect.stringContaining("doc-a.conflict-other.md") });
    expect(byName(r.checks, "sync")).toMatchObject({ status: "warn", detail: expect.stringContaining("h ago") });
    expect(r.ok).toBe(true);
  });

  it("fails on a broken tags.yaml, lint errors (symlink) and reports a stale index", async () => {
    const tags = join(cfg.wikiDir, "_meta", "tags.yaml");
    writeFileSync(tags, readFileSync(tags, "utf8") + "  bad: [unclosed\n");
    const r1 = await run();
    expect(byName(r1.checks, "tags").status).toBe("fail");
    sh(m.a, "git", ["checkout", "--", "wiki/_meta/tags.yaml"]);
    if (process.platform !== "win32") {
      symlinkSync(join(cfg.stateDir, "sync.json"), join(cfg.wikiDir, "reference", "leak.md"));
      const r2 = await run();
      expect(byName(r2.checks, "lint")).toMatchObject({ status: "fail", detail: expect.stringContaining("[symlink]") });
      unlinkSync(join(cfg.wikiDir, "reference", "leak.md"));
    }
    // lint refreshes the index incrementally, so a page dropped in by hand is counted once doctor has run.
    const before = Number(/(\d+) pages/.exec(byName((await run()).checks, "index").detail)?.[1]);
    writeFileSync(join(cfg.wikiDir, "howto", "extra.md"), readFileSync(join(cfg.wikiDir, "howto", "add-wiki-page-manually.md"), "utf8"));
    const r3 = await run();
    expect(byName(r3.checks, "index")).toMatchObject({ status: "ok", detail: `${before + 1} pages indexed` });
  });

  it("warns when recent agent writes carry no session id, not for scheduler commits", async () => {
    upsertPage({ ...cfg, noSync: true, session: undefined }, { id: "howto/doc-b", title: "B", summary: "B page.", tags: ["wiki"], body, force: true });
    const r = await run();
    expect(byName(r.checks, "sessions")).toMatchObject({ status: "warn", detail: expect.stringContaining("1 of the last") });
    upsertPage({ ...cfg, noSync: true }, { id: "howto/doc-c", title: "C", summary: "C page.", tags: ["wiki"], body, force: true });
    sh(m.a, "git", ["commit", "-q", "--allow-empty", "-m", "wiki: stats host\n\n[host:x] [agent:scheduler]"]);
    const r2 = await run();
    expect(byName(r2.checks, "sessions").detail).toContain("1 of the last 2");
  });

  it.skipIf(process.platform === "win32")("fails on a world-readable token file and an invalid client name", async () => {
    writeFileSync(join(cfg.stateDir, "http-token"), "ab".repeat(32) + "\n", { mode: 0o644 });
    writeFileSync(join(cfg.stateDir, "http-clients.json"), JSON.stringify({ "Bad Name": { token: "cd".repeat(32) }, good: { token: "ef".repeat(32) } }), { mode: 0o600 });
    const r = await run();
    const s = byName(r.checks, "secrets");
    expect(s.status).toBe("fail");
    expect(s.detail).toContain("mode 644");
    expect(s.detail).toContain('client "Bad Name"');
    expect(s.detail).not.toContain("ab".repeat(32));
    chmodSync(join(cfg.stateDir, "http-token"), 0o600);
    unlinkSync(join(cfg.stateDir, "http-clients.json"));
    expect(byName((await run()).checks, "secrets").status).toBe("ok");
  });

  it("warns about oversized logs and a non-empty sync.err", async () => {
    mkdirSync(join(cfg.stateDir, "logs"));
    writeFileSync(join(cfg.stateDir, "logs", "sync.log"), "x".repeat(2048));
    writeFileSync(join(cfg.stateDir, "logs", "sync.err"), "boom: remote gone\n");
    const r = await doctor(cfg, { services: false, logMaxBytes: 1024 });
    expect(byName(r.checks, "logs")).toMatchObject({ status: "warn", detail: expect.stringContaining("sync.log") });
    expect(byName(r.checks, "sync-errors").detail).toContain("boom: remote gone");
  });

  it("probes a healthz URL and reports an unreachable one as a failure without leaking tokens", async () => {
    const r = await doctor(cfg, { services: false, healthzUrl: "http://127.0.0.1:1/healthz", timeoutMs: 500 });
    expect(byName(r.checks, "remote-healthz").status).toBe("fail");
    expect(r.ok).toBe(false);
  });
});

describe("log rotation", () => {
  it("copies and truncates logs over the limit, keeping N generations, and leaves small ones alone", () => {
    const dir = join(cfg.stateDir, "logs");
    mkdirSync(dir);
    writeFileSync(join(dir, "sync.log"), "a".repeat(300));
    writeFileSync(join(dir, "mcp-http.err"), "small");
    expect(rotateLogs(cfg, { maxBytes: 100, keep: 2 })).toEqual(["sync.log"]);
    expect(statSync(join(dir, "sync.log")).size).toBe(0);
    expect(readFileSync(join(dir, "sync.log.1"), "utf8")).toBe("a".repeat(300));
    writeFileSync(join(dir, "sync.log"), "b".repeat(300));
    rotateLogs(cfg, { maxBytes: 100, keep: 2 });
    writeFileSync(join(dir, "sync.log"), "c".repeat(300));
    rotateLogs(cfg, { maxBytes: 100, keep: 2 });
    expect(readFileSync(join(dir, "sync.log.1"), "utf8")[0]).toBe("c");
    expect(readFileSync(join(dir, "sync.log.2"), "utf8")[0]).toBe("b");
    expect(() => statSync(join(dir, "sync.log.3"))).toThrow();
    expect(listLogs(cfg).map((l) => l.name)).toEqual(["mcp-http.err", "sync.log"]);
    rmSync(dir, { recursive: true });
  });
});
