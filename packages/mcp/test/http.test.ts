import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeWikiCopy, type Fixture } from "../../core/test/helpers.js";

let fx: Fixture;
let proc: ChildProcess;
const port = 18765 + Math.floor(Math.random() * 1000);
const token = "t".repeat(40);
const base = `http://127.0.0.1:${port}`;

beforeAll(async () => {
  fx = makeWikiCopy();
  const server = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  proc = spawn(process.execPath, [server, "--http", "--port", String(port), "--token", token], {
    env: { ...process.env, DOLTAP_ROOT: fx.dir, DOLTAP_NO_SYNC: "1", DOLTAP_AGENT: "test-http" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    proc.stderr!.on("data", (d: Buffer) => { if (d.toString().includes("listening")) resolve(); });
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
});
afterAll(() => { proc.kill(); fx.cleanup(); });

describe("mcp over streamable http", () => {
  it("rejects wrong paths and non-POST, answers healthz", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/wrong/mcp`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/${token}/mcp`)).status).toBe(405);
  });

  it("serves tools to an SDK client and handles a write", async () => {
    const client = new Client({ name: "http-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/${token}/mcp`)));
    expect((await client.listTools()).tools.length).toBe(11);
    const s = await client.callTool({ name: "wiki_search", arguments: { query: "obsidian" } });
    expect(JSON.parse((s.content as { text: string }[])[0].text).hits[0].id).toBe("reference/obsidian-conventions");
    const p = await client.callTool({ name: "wiki_patch_section", arguments: { id: "reference/obsidian-conventions", section: "Details", content: "- added over http", mode: "append" } });
    expect(p.isError).toBeFalsy();
    const g = await client.callTool({ name: "wiki_get", arguments: { id: "reference/obsidian-conventions", section: "Details" } });
    expect(JSON.parse((g.content as { text: string }[])[0].text).text).toContain("added over http");
    // A second, independent client works too (stateless mode).
    const c2 = new Client({ name: "http-test-2", version: "0" });
    await c2.connect(new StreamableHTTPClientTransport(new URL(`${base}/${token}/mcp`)));
    expect((await c2.readResource({ uri: "wiki://protocol" })).contents[0].text).toContain("Doltap Protocol");
    await c2.close();
    await client.close();
  });
});
