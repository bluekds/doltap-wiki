import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTwoMachines, removeTemp } from "../../core/test/helpers.js";

/** 0.14.0: Gemini CLI became Antigravity CLI (`agy`), which reads MCP servers from ~/.gemini/config/mcp_config.json (remote entries use `serverUrl`). */
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const cli = (args: string[], env: Record<string, string>) =>
  execFileSync(process.execPath, ["--import", "tsx", MAIN, ...args], { cwd: REPO, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DOLTAP_NO_SYNC: "1", ...env } }).trim();

let m: ReturnType<typeof makeTwoMachines>;
let home: string;
let env: Record<string, string>;
beforeEach(() => { m = makeTwoMachines(); home = mkdtempSync(join(tmpdir(), "doltap-home-")); env = { HOME: home, USERPROFILE: home, PATH: "/nonexistent" }; });
afterEach(() => { m.cleanup(); removeTemp(home); });

const cfgFile = () => join(home, ".gemini", "config", "mcp_config.json");
const readCfg = () => JSON.parse(readFileSync(cfgFile(), "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };

describe("integrations install antigravity", () => {
  it("adds a stdio entry to mcp_config.json, keeps other servers, and adds the GEMINI.md section once", () => {
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(cfgFile(), JSON.stringify({ mcpServers: { other: { command: "x", disabled: false } } }));
    const out = cli(["--root", m.a, "integrations", "install", "antigravity"], env);
    expect(out).toContain(`add mcpServers.doltap in ${cfgFile()}`);
    const cfg = readCfg();
    expect(cfg.mcpServers.other).toEqual({ command: "x", disabled: false });
    expect(cfg.mcpServers.doltap.command).toBeTruthy();
    expect(cfg.mcpServers.doltap.env).toMatchObject({ DOLTAP_ROOT: m.a, DOLTAP_AGENT: "antigravity" });
    expect(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8")).toContain("## Doltap Wiki");
    cli(["--root", m.a, "integrations", "install", "antigravity"], env);
    expect(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8").match(/## Doltap Wiki/g)).toHaveLength(1);
  });

  it("writes a remote entry as serverUrl, never prints the token, and status reports http", () => {
    const token = "ab".repeat(32);
    const remote = `https://box.tail1234.ts.net/${token}/mcp`;
    const out = cli(["--root", m.a, "integrations", "install", "antigravity", "--remote", remote], env);
    expect(out).not.toContain(token);
    expect(readCfg().mcpServers.doltap).toEqual({ serverUrl: remote });
    const st = JSON.parse(cli(["--root", m.a, "integrations", "status", "--json"], env)) as { checks: { name: string; status: string; detail: string }[] };
    expect(st.checks.find((c) => c.name === "antigravity")).toMatchObject({ status: "ok" });
    expect(st.checks.find((c) => c.name === "antigravity")?.detail).toContain("http");
  });

  it("uninstall removes only the doltap entry", () => {
    cli(["--root", m.a, "integrations", "install", "antigravity"], env);
    expect(cli(["--root", m.a, "integrations", "uninstall", "antigravity"], env)).toContain("removed mcpServers.doltap");
    expect(readCfg().mcpServers.doltap).toBeUndefined();
  });

  it("the legacy gemini client still writes ~/.gemini/settings.json and points to antigravity", () => {
    const out = cli(["--root", m.a, "integrations", "install", "gemini"], env);
    expect(out).toContain(join(home, ".gemini", "settings.json"));
    expect(out).toContain("integrations install antigravity");
  });
});
