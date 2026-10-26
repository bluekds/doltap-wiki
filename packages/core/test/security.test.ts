import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertPageId, buildLintContext, get, lintPage, parsePage, patchMeta, patchSection, readPage, upsertPage, withWriteLock } from "../src/index.js";
import { cfgFor, makeWikiCopy, sh, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => { fx = makeWikiCopy(); });
afterEach(() => fx.cleanup());

const howtoBody = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";

function gitInit(dir: string): void {
  writeFileSync(join(dir, ".gitignore"), ".doltap/\n");
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.name", "t"]);
  sh(dir, "git", ["config", "user.email", "t@t"]);
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "seed"]);
}

describe("page id guard", () => {
  it("accepts real ids and rejects anything that could leave wiki/", () => {
    for (const ok of ["Home", "howto/_index", "howto/deploy-pypi", "projects/agentwiki/_index", "projects/agentwiki/environment", "_meta/PROTOCOL"]) expect(assertPageId(ok)).toBe(ok);
    for (const bad of ["../x", "howto/../../escaped", "howto/./x", "/etc/passwd", "howto//x", "howto/", "", "howto\\x", "howto/x.md", "howto/x\n", "a".repeat(300)]) {
      expect(() => assertPageId(bad), bad).toThrow(/invalid page id/);
    }
  });

  it("readPage and get refuse to read outside wiki/", () => {
    const cfg = cfgFor(fx.dir);
    writeFileSync(join(fx.dir, "outside.md"), "---\ntitle: OUTSIDE\n---\nOUTSIDE-FILE-CONTENT\n");
    expect(() => readPage(cfg, "../outside")).toThrow(/invalid page id/);
    expect(() => get(cfg, "../outside")).toThrow(/invalid page id/);
    expect(() => get(cfg, "howto/../../outside")).toThrow(/invalid page id/);
    expect(readPage(cfg, "howto/add-wiki-page-manually")?.meta.title).toBeTruthy();
  });

  it("upsert, patch and meta refuse traversal ids and leave no file behind", () => {
    gitInit(fx.dir);
    const cfg = cfgFor(fx.dir);
    expect(() => upsertPage(cfg, { id: "howto/../../escaped", title: "T", summary: "S", tags: ["wiki"], body: howtoBody, force: true })).toThrow(/invalid page id/);
    expect(existsSync(join(fx.dir, "escaped.md"))).toBe(false);
    expect(existsSync(join(fx.dir, "wiki", "escaped.md"))).toBe(false);
    expect(readPage(cfg, "howto/_index")?.body).not.toContain("escaped");
    expect(() => patchSection(cfg, { id: "howto/../../outside", section: "Pitfalls", content: "INJECTED" })).toThrow(/invalid page id/);
    expect(() => patchMeta(cfg, { id: "howto/../../outside", confidence: "deprecated" })).toThrow(/invalid page id/);
    expect(sh(fx.dir, "git", ["status", "--porcelain"])).toBe("");
  });
});

describe("secret lint", () => {
  const frame = (line: string) => `---\ntitle: T\ncategory: howto\nsummary: S\ntags: [wiki]\nconfidence: draft\ncreated: 2026-10-18\nupdated: 2026-10-18\nsources: []\n---\n\n## Prerequisites\n\n${line}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;
  const secretRules = (line: string) => {
    const cfg = cfgFor(fx.dir);
    const page = parsePage(cfg, "howto/x.md", frame(line));
    return lintPage(page, buildLintContext(cfg, new Set(["howto/_index"]), new Map())).filter((i) => i.rule === "secret").map((i) => i.message);
  };
  const hex64 = "0123456789abcdef".repeat(4);

  it("catches the connector URL and common token formats", () => {
    // Samples are concatenated at runtime so secret scanners do not flag this file as containing real credentials.
    const positives: [string, RegExp][] = [
      [`Connector: https://box.tail1234.ts.net/${hex64}/mcp`, /connector-url/],
      [`Local: http://127.0.0.1:8765/${hex64}/mcp`, /connector-url/],
      [`token ${"github_" + "pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}`, /github-token/],
      [`key ${"AIza" + "SyA1234567890abcdefghijklmnopqrstuvw"}`, /google-api-key/],
      [`${"glpat" + "-abcdefghijklmnopqrstuvwx"}`, /gitlab-token/],
      [`${"sk_" + "live_abcdefghijklmnopqrstuvwxyz123456"}`, /stripe-key/],
      [`${"npm" + "_abcdefghijklmnopqrstuvwxyz0123456789"}`, /npm-token/],
      [`${"hf" + "_abcdefghijklmnopqrstuvwxyzABCDEFGH"}`, /huggingface-token/],
      [`Authorization: ${"Bearer" + " abcdefghijklmnopqrstuvwxyz0123456789"}`, /bearer-token/],
      ["API_KEY=a1b2c3d4e5f6g7h8i9j0k1l2m3n4", /credential-assignment/],
      ['DB_PASSWORD="hunter2hunter2"', /credential-assignment/],
      [`${"sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789"}`, /anthropic-key/],
    ];
    for (const [line, rule] of positives) expect(secretRules(line).join(" "), line).toMatch(rule);
    expect(secretRules(`${"sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789"}`).join(" ")).not.toMatch(/openai-key/);
  });

  it("does not flag the recommended 'where the secret lives' style or ordinary prose", () => {
    const negatives = [
      "- GB10 admin password: 1Password item \"GB10 admin\"",
      "load: `export ORCAROUTER_API_KEY=$(security find-generic-password -s orcarouter-api -w)`",
      "Read the token with `doltap serve token`, rotate with `doltap serve token --rotate`",
      "- figureSpin bot token: `.env` of the server repo, key `TELEGRAM_BOT_TOKEN`",
      "The endpoint is https://box.tail1234.ts.net/<token>/mcp (token in .doltap/http-token)",
      "password: see the Keychain",
      "secret: stored in Vault at kv/app",
      "commit 2c9aabd0f1e2d3c4b5a69788796a5b4c3d2e1f00 fixed it",
      "Set API_KEY=<your-key> in .env",
      "token = os.environ[\"TOKEN\"]",
    ];
    for (const line of negatives) expect(secretRules(line), line).toEqual([]);
  });
});

describe("write lock", () => {
  it("serializes writers, is re-entrant, and clears a stale lock", () => {
    const cfg = cfgFor(fx.dir);
    const lock = join(cfg.stateDir, "write.lock");
    const order: string[] = [];
    withWriteLock(cfg, () => {
      expect(existsSync(lock)).toBe(true);
      withWriteLock(cfg, () => order.push("nested"));
      order.push("outer");
    });
    expect(order).toEqual(["nested", "outer"]);
    expect(existsSync(lock)).toBe(false);
    // Another holder: a fresh lock file makes us wait, then time out.
    writeFileSync(lock, "999999\n");
    expect(() => withWriteLock(cfg, () => "x", { timeoutMs: 300 })).toThrow(/another doltap write is in progress/);
    // A stale lock (older than the stale threshold) is removed.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, old, old);
    expect(withWriteLock(cfg, () => "ran", { timeoutMs: 300 })).toBe("ran");
    expect(existsSync(lock)).toBe(false);
  });

  it("six concurrent processes all land in the hub and in git with a clean tree", { timeout: 120_000 }, async () => {
    gitInit(fx.dir);
    const script = fileURLToPath(new URL("./concurrent-writer.ts", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const ids = [1, 2, 3, 4, 5, 6].map((n) => `howto/conc-page-${n}`);
    const run = promisify(execFile);
    const results = await Promise.allSettled(ids.map((id) => run(process.execPath, ["--import", "tsx", script, fx.dir, id], { cwd: repoRoot, env: { ...process.env, DOLTAP_NO_SYNC: "1" } })));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => String((r.reason as { stderr?: string }).stderr ?? r.reason));
    expect(failures).toEqual([]);
    const cfg = cfgFor(fx.dir);
    const hub = readPage(cfg, "howto/_index")!.body;
    for (const id of ids) {
      expect(existsSync(join(fx.dir, "wiki", `${id}.md`))).toBe(true);
      expect(hub).toContain(`[[${id}]]`);
    }
    expect(sh(fx.dir, "git", ["status", "--porcelain"])).toBe("");
    expect(sh(fx.dir, "git", ["rev-list", "--count", "HEAD"])).toBe("7");
    expect(statSync(join(fx.dir, "wiki", "howto", "conc-page-1.md")).size).toBeGreaterThan(0);
    expect(readFileSync(join(fx.dir, "wiki", "howto", "_index.md"), "utf8").split("[[howto/conc-page-").length).toBe(7);
  });
});
