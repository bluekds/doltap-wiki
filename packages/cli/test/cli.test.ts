import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTwoMachines, sh } from "../../core/test/helpers.js";

// Runs the CLI source through tsx; @bluekds/doltap-core resolves to packages/core/dist, so build first (CI does).
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
function cli(args: string[], env: Record<string, string> = {}, input?: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", MAIN, ...args], { cwd: REPO, encoding: "utf8", input: input ?? "", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();
}

let m: ReturnType<typeof makeTwoMachines>;
beforeEach(() => { m = makeTwoMachines(); });
afterEach(() => m.cleanup());

const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";

describe("doltap CLI", () => {
  it("honours DOLTAP_NO_SYNC=1 (commit locally, never push)", () => {
    const before = sh(m.bare, "git", ["rev-list", "--count", "main"]);
    const out = cli(["--root", m.a, "add", "howto/env-no-sync", "--title", "T", "--summary", "S.", "--tags", "wiki", "--force", "--stdin"], { DOLTAP_NO_SYNC: "1" }, body);
    expect(out).toContain("created howto/env-no-sync");
    expect(sh(m.a, "git", ["log", "-1", "--format=%s"])).toBe("wiki: add howto/env-no-sync");
    expect(sh(m.bare, "git", ["rev-list", "--count", "main"])).toBe(before);
  });

  it("never prints the remote token in integrations --dry-run output", () => {
    const home = mkdtempSync(join(tmpdir(), "doltap-home-"));
    try {
      const token = "ef".repeat(32);
      const out = cli(["integrations", "install", "claude", "--remote", `https://box.tail1234.ts.net/${token}/mcp`, "--dry-run"], { HOME: home });
      expect(out).not.toContain(token);
      expect(out).toContain("<token>");
      const viaEnv = cli(["integrations", "install", "claude", "--remote", "--dry-run"], { HOME: home, DOLTAP_REMOTE_URL: `https://box.tail1234.ts.net/${token}/mcp` });
      expect(viaEnv).not.toContain(token);
      expect(viaEnv).toContain("--transport http doltap https://box.tail1234.ts.net/<token>/mcp");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("doctor and integrations status (0.4)", () => {
  it("doctor --json --no-services reports checks and exits 1 only on failures", () => {
    const ok = JSON.parse(cli(["--root", m.a, "doctor", "--json", "--no-services"]));
    expect(ok.ok).toBe(true);
    expect(ok.checks.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["repo", "remote", "sync", "lint", "tags", "index", "sessions"]));
    expect(ok.checks.find((c: { name: string }) => c.name === "skill")).toBeUndefined();
    sh(m.a, "git", ["checkout", "-q", "--detach"]);
    let code = 0;
    let outText = "";
    try { outText = cli(["--root", m.a, "doctor", "--no-services", "--quiet"]); } catch (e) { const err = e as { status: number; stdout: string }; code = err.status; outText = err.stdout; }
    expect(code).toBe(1);
    expect(outText).toContain("fail repo");
    expect(outText).not.toContain("ok   lint");
  });

  it("integrations status tells a stale skill copy from a current one", () => {
    const home = mkdtempSync(join(tmpdir(), "doltap-home-"));
    try {
      const env = { HOME: home, USERPROFILE: home, PATH: "/nonexistent" }; // homedir() reads USERPROFILE on Windows
      const none = JSON.parse(cli(["integrations", "status", "--json"], env));
      expect(none.checks.find((c: { name: string }) => c.name === "skill")).toMatchObject({ status: "warn", fix: "doltap integrations install claude" });
      expect(none.checks.find((c: { name: string }) => c.name === "mcp-registration").status).toBe("skip");
      cli(["--root", m.a, "integrations", "install", "claude"], env);
      const fresh = JSON.parse(cli(["integrations", "status", "--json"], env));
      expect(fresh.checks.find((c: { name: string }) => c.name === "skill").status).toBe("ok");
      expect(fresh.checks.find((c: { name: string }) => c.name === "instructions").status).toBe("ok");
      const skill = join(home, ".claude", "skills", "doltap", "SKILL.md");
      writeFileSync(skill, readFileSync(skill, "utf8") + "\nlocal edit\n");
      const stale = JSON.parse(cli(["integrations", "status", "--json"], env));
      expect(stale.checks.find((c: { name: string }) => c.name === "skill")).toMatchObject({ status: "warn", detail: expect.stringContaining("differs") });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
