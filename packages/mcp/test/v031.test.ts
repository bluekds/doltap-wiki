import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, type WikiConfig } from "@bluekds/doltap-core";
import { defaultSession, loadClients, startHttpServer } from "../src/http.js";

const TOKEN = "ab".repeat(32);
const LAPTOP = "cd".repeat(32);
const BAD = "ef".repeat(32);
let dir: string;
let cfg: WikiConfig;
let srv: Awaited<ReturnType<typeof startHttpServer>>;
let base: string;

const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "doltap-http031-"));
  cpSync(fileURLToPath(new URL("../../core/test/fixtures/wiki/", import.meta.url)), join(dir, "wiki"), { recursive: true });
  cpSync(fileURLToPath(new URL("../../../.gitignore", import.meta.url)), join(dir, ".gitignore"));
  g(["init", "-q", "-b", "main"]);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "seed"]);
  cfg = resolveConfig({ root: dir, noSync: true, agent: "test" });
  writeFileSync(
    join(cfg.stateDir, "http-clients.json"),
    JSON.stringify({ laptop: { token: LAPTOP, readOnly: false, created: "2026-10-27" }, "evil]\n\n[host:spoofed": { token: BAD, readOnly: false, created: "2026-10-27" } }),
  );
  srv = await startHttpServer(cfg, { port: 0, host: "127.0.0.1", token: TOKEN, maxBodyBytes: 64 * 1024 });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const call = (token: string, name: string, args: Record<string, unknown>) =>
  fetch(`${base}/${token}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }) }).then((r) => r.text());
const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";

describe("sessions over HTTP", () => {
  it("the client that created a page cannot verify it in the same session", async () => {
    const up = await call(LAPTOP, "wiki_upsert", { id: "howto/http-self", title: "Self", summary: "Created over HTTP by laptop.", tags: ["wiki"], body, force: true });
    expect(up).not.toContain("isError");
    const v = await call(LAPTOP, "wiki_verify", { id: "howto/http-self", evidence: "I created it a second ago, it works" });
    expect(v).toContain("same session");
    expect(v).toContain("isError");
    const log = g(["log", "-1", "--format=%B"]).toString();
    expect(log).toMatch(/\[session:laptop@\d{4}-\d{2}-\d{2}\]/);
  });
  it("a stdio server gets a session of its own when the environment has none", () => {
    const prev = { s: process.env.DOLTAP_SESSION, c: process.env.CLAUDE_CODE_SESSION_ID };
    try {
      delete process.env.DOLTAP_SESSION;
      delete process.env.CLAUDE_CODE_SESSION_ID;
      const a = defaultSession();
      expect(a).toMatch(/^mcp-[0-9a-f]{12}$/);
      expect(defaultSession()).toBe(a);
    } finally {
      if (prev.s === undefined) delete process.env.DOLTAP_SESSION; else process.env.DOLTAP_SESSION = prev.s;
      if (prev.c === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev.c;
    }
  });
});

describe("client names", () => {
  it("a client whose name is not kebab-case is ignored, so its token does not authenticate", async () => {
    expect(Object.keys(loadClients(cfg))).toEqual(["laptop"]);
    const r = await fetch(`${base}/${BAD}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) });
    expect(r.status).toBe(404);
  });
});

describe("wiki_history (0.4)", () => {
  it("returns the commits of a page with trailers and refuses unknown pages", async () => {
    const raw = await call(LAPTOP, "wiki_history", { id: "howto/http-self", limit: 5 });
    const data = raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? raw;
    const entries = JSON.parse(JSON.parse(data).result.content[0].text).entries;
    expect(entries[0]).toMatchObject({ action: "add", agent: "laptop", host: expect.any(String) });
    expect(entries[0].session).toMatch(/^laptop@\d{4}-\d{2}-\d{2}$/);
    expect(await call(LAPTOP, "wiki_history", { id: "howto/does-not-exist" })).toContain("isError");
  });
});
