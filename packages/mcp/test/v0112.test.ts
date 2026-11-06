import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { WikiDb, resolveConfig, type WikiConfig } from "@bluekds/doltap-core";
import { makeWikiCopy, type Fixture } from "../../core/test/helpers.js";
import { createServer } from "../src/server.js";

/**
 * 0.11.2, independent audit of v0.11.1: a read-only client reading `wiki://index` must not write the index
 * file (02); `wiki_audit` must not hand search query text to clients, read-only ones least of all (04);
 * `_meta/...` ids are refused by the write tools at the schema (03).
 */
let fx: Fixture;
let cfg: WikiConfig;
let ro: Client;
let rw: Client;
const connect = async (c: WikiConfig, readOnly: boolean) => {
  const server = createServer(c, { readOnly });
  const client = new Client({ name: readOnly ? "ro" : "rw", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return client;
};
beforeAll(async () => {
  fx = makeWikiCopy();
  cfg = resolveConfig({ root: fx.dir, agent: "test", noSync: true });
  ro = await connect({ ...cfg, agent: "laptop" }, true);
  rw = await connect(cfg, false);
});
afterAll(async () => { await ro.close(); await rw.close(); fx.cleanup(); });

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0]?.text ?? "";

describe("02: wiki://index for a read-only client", () => {
  it("returns the index without creating or rewriting wiki/_meta/index.md", async () => {
    const p = join(cfg.wikiDir, "_meta", "index.md");
    expect(existsSync(p)).toBe(false);
    const r = await ro.readResource({ uri: "wiki://index" });
    expect((r.contents[0] as { text: string }).text).toContain("`decisions/wiki-storage-markdown-git`");
    expect(existsSync(p)).toBe(false);
  });
});

describe("04: wiki_audit never carries search query text", () => {
  it("lists misses by the page opened and the count only", async () => {
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      db.logSearch("api-key-internal-dev secret phrase", ["howto/add-wiki-page-manually"]);
      await new Promise((r) => setTimeout(r, 20)); // the follow-up read must be later than the search
      db.logAccess("decisions/wiki-storage-markdown-git");
    } finally { db.close(); }
    for (const c of [ro, rw]) {
      const out = text(await c.callTool({ name: "wiki_audit", arguments: {} }));
      expect(out).not.toContain("api-key-internal-dev");
      expect(out).not.toMatch(/"query"/);
      // The miss itself is still reported: the page that was opened instead, its rank and the count.
      expect(JSON.parse(out).searchMisses).toEqual([expect.objectContaining({ opened: "decisions/wiki-storage-markdown-git", count: 1 })]);
    }
  });
});

describe("03: write tools refuse _meta ids at the schema", () => {
  it("wiki_patch_section and wiki_set_meta reject _meta/PROTOCOL before touching the wiki", async () => {
    const patch = await rw.callTool({ name: "wiki_patch_section", arguments: { id: "_meta/PROTOCOL", section: "x", content: "y", create: true } });
    expect(patch.isError).toBe(true);
    expect(text(patch)).not.toMatch(/committed|rev/);
    const meta = await rw.callTool({ name: "wiki_set_meta", arguments: { id: "_meta/templates/howto", title: "t" } });
    expect(meta.isError).toBe(true);
    const mtime = statSync(join(cfg.wikiDir, "_meta", "PROTOCOL.md")).mtimeMs;
    expect(statSync(join(cfg.wikiDir, "_meta", "PROTOCOL.md")).mtimeMs).toBe(mtime);
  });
});
