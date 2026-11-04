import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTwoMachines, sh } from "../../core/test/helpers.js";

/** 0.9.1 core audit L5 / M10: exit codes do not depend on --json; `init --new` never swallows an existing directory. */
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
function run(args: string[], env: Record<string, string> = {}, input?: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", MAIN, ...args], { cwd: REPO, encoding: "utf8", input: input ?? "", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    return { code: 0, out: out.trim() };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}`.trim() };
  }
}

const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";

describe("exit codes (L5)", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  beforeEach(() => { m = makeTwoMachines(); });
  afterEach(() => m.cleanup());

  it("a refused meta or patch exits 2 with and without --json", () => {
    expect(run(["--root", m.a, "add", "howto/codes", "--title", "T", "--summary", "S.", "--tags", "wiki", "--force", "--stdin"], { DOLTAP_NO_SYNC: "1" }, body).code).toBe(0);
    const plain = run(["--root", m.a, "meta", "howto/codes", "--add-tag", "no-such-tag"], { DOLTAP_NO_SYNC: "1" });
    expect(plain.code).toBe(2);
    expect(plain.out).toContain("refused");
    const json = run(["--root", m.a, "meta", "howto/codes", "--add-tag", "no-such-tag", "--json"], { DOLTAP_NO_SYNC: "1" });
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out).refused).toBe("lint errors");
    const stale = run(["--root", m.a, "patch", "howto/codes", "--section", "Pitfalls", "--base-rev", "0000000000000000", "--json", "--stdin"], { DOLTAP_NO_SYNC: "1" }, "- p");
    expect(stale.code).toBe(2);
    expect(JSON.parse(stale.out).refused).toMatch(/stale|changed/);
  });
});

describe("init --new on an existing directory (M10)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doltap-existing-"));
    sh(dir, "git", ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n");
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    writeFileSync(join(dir, "dot.config"), "user file\n");
    sh(dir, "git", ["add", ".gitignore", "dot.config"]);
    sh(dir, "git", ["commit", "-qm", "existing project"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  it("refuses a non-empty directory and leaves it untouched", () => {
    const r = run(["init", "--new", "--dir", dir]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not empty|--force/);
    expect(existsSync(join(dir, "wiki"))).toBe(false);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n.env\n");
    expect(existsSync(join(dir, "dot.config"))).toBe(true);
    expect(sh(dir, "git", ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("with --force merges .gitignore, renames only skeleton files and commits only the skeleton", () => {
    const r = run(["init", "--new", "--force", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "wiki", "_meta", "PROTOCOL.md"))).toBe(true);
    const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(ignore).toContain("node_modules/");
    expect(ignore).toContain(".env");
    expect(ignore).toContain(".doltap/");
    expect(existsSync(join(dir, "dot.config"))).toBe(true);
    expect(existsSync(join(dir, ".config"))).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    const committed = sh(dir, "git", ["show", "--name-only", "--format=", "HEAD"]).split("\n");
    expect(committed).not.toContain(".env");
    expect(committed.some((f) => f.startsWith("wiki/"))).toBe(true);
    expect(committed).toContain(".gitignore");
  });
});
