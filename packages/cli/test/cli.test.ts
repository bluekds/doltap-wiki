import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
