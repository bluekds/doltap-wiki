import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("golden (0.5)", () => {
  it("golden runs the default set, prints misses and exits 1 on a miss", () => {
    expect(cli(["--root", m.a, "golden"])).toContain("no golden set");
    const file = join(m.a, "wiki", "_meta", "golden.json");
    writeFileSync(file, JSON.stringify([{ query: "obsidian backlink", expect: "reference/obsidian-conventions" }]));
    expect(cli(["--root", m.a, "golden"])).toContain("1/1 golden queries first");
    writeFileSync(file, JSON.stringify([{ query: "obsidian backlink", expect: "Home", note: "wrong" }]));
    let code = 0; let outText = "";
    try { outText = cli(["--root", m.a, "golden"]); } catch (e) { const err = e as { status: number; stdout: string }; code = err.status; outText = err.stdout; }
    expect(code).toBe(1);
    expect(outText).toContain("miss  \"obsidian backlink\"");
    expect(outText).toContain("# wrong");
    let jsonOut = "";
    try { jsonOut = cli(["--root", m.a, "golden", "--json", file]); } catch (e) { jsonOut = (e as { stdout: string }).stdout; }
    expect(JSON.parse(jsonOut).misses).toHaveLength(1);
  });
});

describe("clients, call log and integrations (0.6)", () => {
  it("client add --expires, list, extend and doctor's expiry warning", () => {
    const token = cli(["--root", m.a, "serve", "client", "add", "laptop", "--expires", "30"]);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const list = JSON.parse(cli(["--root", m.a, "serve", "client", "list", "--json"])) as { name: string; expires: string | null; daysLeft: number | null }[];
    expect(list[0]).toMatchObject({ name: "laptop" });
    expect(list[0].expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(list[0].daysLeft).toBeGreaterThanOrEqual(29);
    expect(cli(["--root", m.a, "serve", "client", "extend", "laptop", "--expires", "2026-01-31"])).toContain("expires 2026-01-31");
    expect(cli(["--root", m.a, "serve", "client", "list"])).toContain("EXPIRED 2026-01-31");
    const doc = JSON.parse(cli(["--root", m.a, "doctor", "--json", "--no-services"])) as { checks: { name: string; status: string; detail: string }[] };
    const secrets = doc.checks.find((c) => c.name === "secrets")!;
    expect(secrets.status).toBe("warn");
    expect(secrets.detail).toContain("laptop expired 2026-01-31");
    expect(cli(["--root", m.a, "serve", "client", "extend", "laptop", "--expires", "never"])).toContain("never expires");
    expect(cli(["--root", m.a, "serve", "client", "list"])).toContain("never expires");
    expect(() => cli(["--root", m.a, "serve", "client", "add", "other", "--expires", "soon"])).toThrow(/days/);
  });

  it("serve calls summarises the HTTP call log", () => {
    expect(cli(["--root", m.a, "serve", "calls"])).toContain("no HTTP calls");
    const dir = join(m.a, ".doltap", "logs");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    writeFileSync(join(dir, "http-calls.log"), `${ts} laptop tools/call wiki_search 200 12\n${ts} laptop tools/call wiki_get 200 8\n${ts} old - - expired 1\n${ts} laptop tools/call wiki_search 200 9\n`);
    const r = JSON.parse(cli(["--root", m.a, "serve", "calls", "--json"])) as { calls: number; summary: { client: string; calls: number; errors: number; tools: [string, number][] }[] };
    expect(r.calls).toBe(4);
    expect(r.summary[0]).toMatchObject({ client: "laptop", calls: 3, errors: 0 });
    expect(r.summary[0].tools[0]).toEqual(["wiki_search", 2]);
    expect(r.summary[1]).toMatchObject({ client: "old", calls: 1, errors: 1 });
    const text = cli(["--root", m.a, "serve", "calls", "-n", "2"]);
    expect(text).toContain("4 call(s)");
    expect(text).toContain("wiki_search 2");
  });

  it("integrations install writes cursor, gemini and codex configs, status sees them, uninstall removes them", () => {
    const home = mkdtempSync(join(tmpdir(), "doltap-home-"));
    const env = { HOME: home, USERPROFILE: home, PATH: "/nonexistent" };
    const token = "ef".repeat(32);
    const remote = `https://box.tail1234.ts.net/${token}/mcp`;
    // Cursor: stdio entry with env; the instruction text is printed for the settings UI.
    const cur = cli(["--root", m.a, "integrations", "install", "cursor"], env);
    expect(cur).toContain("add mcpServers.doltap");
    expect(cur).toContain("User Rules");
    const cursorCfg = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")) as { mcpServers: { doltap: { command: string; env: Record<string, string> } } };
    expect(cursorCfg.mcpServers.doltap.env).toMatchObject({ DOLTAP_ROOT: m.a, DOLTAP_AGENT: "cursor" });
    expect(cursorCfg.mcpServers.doltap.command).toBeTruthy();
    // Gemini: remote entry uses httpUrl; GEMINI.md gets the section once; the token is never printed.
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
    const gem = cli(["--root", m.a, "integrations", "install", "gemini", "--remote", remote], env);
    expect(gem).not.toContain(token);
    const gemCfg = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")) as { theme: string; mcpServers: Record<string, Record<string, string>> };
    expect(gemCfg.theme).toBe("dark");
    expect(gemCfg.mcpServers.other).toEqual({ command: "x" });
    expect(gemCfg.mcpServers.doltap).toEqual({ httpUrl: remote });
    expect(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8")).toContain("## Doltap Wiki");
    cli(["--root", m.a, "integrations", "install", "gemini", "--remote", remote], env);
    expect(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8").match(/## Doltap Wiki/g)).toHaveLength(1);
    // Codex: TOML block replaces an older doltap block and keeps other tables.
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "o3"\n\n[mcp_servers.doltap]\ncommand = "old"\n\n[mcp_servers.doltap.env]\nX = "1"\n\n[mcp_servers.other]\ncommand = "keep"\n');
    const cod = cli(["--root", m.a, "integrations", "install", "codex"], env);
    expect(cod).toContain("replace [mcp_servers.doltap]");
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('model = "o3"');
    expect(toml).toContain("[mcp_servers.other]\ncommand = \"keep\"");
    expect(toml).not.toContain('command = "old"');
    expect(toml).toContain('DOLTAP_AGENT = "codex"');
    expect(toml.match(/\[mcp_servers\.doltap\]/g)).toHaveLength(1);
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toContain("## Doltap Wiki");
    // status lists all three; generic prints masked JSON.
    const st = JSON.parse(cli(["--root", m.a, "integrations", "status", "--json"], env)) as { checks: { name: string; status: string; detail: string }[] };
    expect(st.checks.find((c) => c.name === "cursor")).toMatchObject({ status: "ok" });
    expect(st.checks.find((c) => c.name === "gemini")?.detail).toContain("http");
    expect(st.checks.find((c) => c.name === "codex")?.detail).toContain("stdio");
    const gen = cli(["--root", m.a, "integrations", "install", "generic", "--remote", remote], env);
    expect(gen).toContain('"DOLTAP_AGENT": "<client-name>"');
    expect(gen).toContain("<token>");
    expect(gen).not.toContain(token);
    expect(cli(["--root", m.a, "integrations", "install", "generic", "--remote", remote, "--show-url"], env)).toContain(token);
    // uninstall
    expect(cli(["--root", m.a, "integrations", "uninstall", "codex"], env)).toContain("removed [mcp_servers.doltap]");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.other]");
    expect(cli(["--root", m.a, "integrations", "uninstall", "gemini"], env)).toContain("removed mcpServers.doltap");
    expect((JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers.doltap).toBeUndefined();
    const st2 = JSON.parse(cli(["--root", m.a, "integrations", "status", "--json"], env)) as { checks: { name: string; status: string }[] };
    expect(st2.checks.find((c) => c.name === "codex")?.status).toBe("skip");
    rmSync(home, { recursive: true, force: true });
  });
});
