import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readPage, resolveConfig, type WikiConfig } from "@bluekds/doltap-core";
import { makeTwoMachines } from "../../core/test/helpers.js";
import { createServer } from "../src/server.js";

/** 0.9.1 core audit M5 / M12 at the MCP layer: wiki_upsert replace keeps confidence; a project overview id is accepted. */
let m: ReturnType<typeof makeTwoMachines>;
let cfg: WikiConfig;
let client: Client;
beforeAll(async () => {
  m = makeTwoMachines();
  cfg = { ...resolveConfig({ root: m.a, agent: "test", session: "sess-mcp" }), autoPullMinutes: 0 };
  const server = createServer(cfg);
  client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
});
afterAll(async () => { await client.close(); m.cleanup(); });

const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]?.text ?? "";
  return { isError: !!r.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

describe("wiki_upsert replace", () => {
  it("keeps a verified page verified and refuses a deprecated one", async () => {
    const id = "decisions/wiki-storage-markdown-git";
    const got = await call("wiki_get", { id });
    const r = await call("wiki_upsert", { id, title: "Store the wiki as Markdown + git", summary: "Rewritten over MCP.", tags: ["wiki"], body: "## Context\n\nnew\n\n## Options\n\nnew\n\n## Decision\n\nnew\n\n## Consequences\n\nnew\n\n## Related\n\n- [[decisions/_index]]\n", replace: true, base_rev: got.json.rev });
    expect(r.isError).toBe(false);
    expect(readPage(cfg, id)!.meta.confidence).toBe("verified");
    const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";
    expect((await call("wiki_upsert", { id: "howto/old", title: "Old", summary: "Old.", tags: ["wiki"], body, force: true })).isError).toBe(false);
    expect((await call("wiki_upsert", { id: "howto/new", title: "New", summary: "New.", tags: ["wiki"], body, force: true })).isError).toBe(false);
    expect((await call("wiki_deprecate", { id: "howto/old", replaced_by: "howto/new" })).isError).toBe(false);
    const again = await call("wiki_upsert", { id: "howto/old", title: "Old", summary: "Revived.", tags: ["wiki"], body, replace: true, base_rev: (await call("wiki_get", { id: "howto/old" })).json.rev });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/deprecated/);
  });
});

describe("wiki_upsert ids", () => {
  it("accepts projects/<slug>/_index for a project overview and still rejects _index elsewhere", async () => {
    const body = "## Overview\n\no\n\n## Environment\n\ne\n\n## Wiki pages used by this project\n\n- [[howto/_index]]\n\n## Project-only notes\n\n- n\n\n## Related\n\n- [[projects/_index]]\n";
    const r = await call("wiki_upsert", { id: "projects/alpha/_index", title: "Alpha", summary: "Project alpha.", tags: ["wiki"], body, force: true });
    expect(r.text).not.toMatch(/validation/);
    expect(r.isError).toBe(false);
    expect(readPage(cfg, "projects/alpha/_index")).not.toBeNull();
    const bad = await call("wiki_upsert", { id: "howto/alpha/_index", title: "Alpha", summary: "Project alpha.", tags: ["wiki"], body, force: true });
    expect(bad.isError).toBe(true);
    const hub = await call("wiki_upsert", { id: "howto/_index", title: "Hub", summary: "Hub.", tags: ["wiki"], body, force: true });
    expect(hub.isError).toBe(true);
  });
});

describe("wiki_sync under a foreign write lock (M2c)", () => {
  it("fails fast with the configured lock timeout instead of blocking the event loop for 30 s", async () => {
    const { spawn } = await import("node:child_process");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { writeLockPath } = await import("@bluekds/doltap-core");
    // A generous timeout: the read must come back while the sync is still waiting, on a slow Windows runner too.
    const fast = createServer(cfg, { lockTimeoutMs: 1500 });
    const c = new Client({ name: "fast", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await fast.connect(a);
    await c.connect(b);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    writeFileSync(writeLockPath(cfg), `${child.pid} ${new Date().toISOString()}\n`);
    try {
      const t0 = Date.now();
      // A read served while the sync waits proves the loop is not blocked by a synchronous lock wait.
      const [sync, read] = await Promise.all([
        c.callTool({ name: "wiki_sync", arguments: {} }),
        new Promise((r) => setTimeout(r, 100)).then(() => c.callTool({ name: "wiki_list", arguments: {} })).then(() => Date.now() - t0),
      ]);
      expect(sync.isError).toBe(true);
      expect((sync.content as { text: string }[])[0].text).toMatch(/write is in progress/);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(read).toBeLessThan(1000);
    } finally {
      child.kill();
      try { unlinkSync(writeLockPath(cfg)); } catch { /* gone */ }
      await c.close();
    }
  });
});

describe("M7 / S13: conflict copies over MCP, paths in errors", () => {
  it("wiki_get returns each conflict copy with its body so an MCP-only agent can merge", async () => {
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const page = join(m.a, "wiki", "howto", "add-wiki-page-manually.md");
    writeFileSync(join(m.a, "wiki", "howto", "add-wiki-page-manually.conflict-other-box.md"), readFileSync(page, "utf8").replace("## Steps", "## Steps\n\nOTHER-BOX-EDIT"));
    const r = await call("wiki_get", { id: "howto/add-wiki-page-manually" });
    expect(r.isError).toBe(false);
    expect(r.json.conflict_copies).toHaveLength(1);
    expect(r.json.conflict_copies[0].path).toBe("howto/add-wiki-page-manually.conflict-other-box.md");
    expect(r.json.conflict_copies[0].body).toContain("OTHER-BOX-EDIT");
    const done = await call("wiki_resolve_conflict", { id: "howto/add-wiki-page-manually", take: "conflict" });
    expect(done.isError).toBe(false);
  });

  it("a tool error never carries the wiki's absolute path", async () => {
    const { spawn } = await import("node:child_process");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { writeLockPath } = await import("@bluekds/doltap-core");
    const fast = createServer(cfg, { lockTimeoutMs: 200 });
    const c = new Client({ name: "fast", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await fast.connect(a);
    await c.connect(b);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    writeFileSync(writeLockPath(cfg), `${child.pid} ${new Date().toISOString()}\n`);
    try {
      const r = await c.callTool({ name: "wiki_set_meta", arguments: { id: "howto/add-wiki-page-manually", add_sources: ["x"] } });
      const text = (r.content as { text: string }[])[0].text;
      expect(r.isError).toBe(true);
      expect(text).toMatch(/write is in progress/);
      expect(text).not.toContain(m.a);
      // The tool result is JSON, so a Windows backslash arrives doubled.
      expect(text).toMatch(/<wiki>[\\/]+\.doltap[\\/]+write\.lock/);
    } finally {
      child.kill();
      try { unlinkSync(writeLockPath(cfg)); } catch { /* gone */ }
      await c.close();
    }
  });
});
