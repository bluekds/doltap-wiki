import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveConfig } from "@bluekds/doltap-core";
import { makeWikiCopy, type Fixture } from "../../core/test/helpers.js";
import { createServer, LIMITS } from "../src/server.js";

/** 0.9 security audit S4/S6: tool inputs carry size caps so one call cannot hand the parser megabytes. */
let fx: Fixture;
let client: Client;
beforeAll(async () => {
  fx = makeWikiCopy();
  const server = createServer(resolveConfig({ root: fx.dir, agent: "test", noSync: true }));
  client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
});
afterAll(async () => { await client.close(); fx.cleanup(); });

const errOf = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  return r.isError ? (r.content as { text: string }[])[0].text : null;
};

describe("input caps", () => {
  it("query, body, content and section are capped; the caps are documented", async () => {
    expect(LIMITS.query).toBe(500);
    expect(await errOf("wiki_search", { query: "x".repeat(LIMITS.query + 1) })).toMatch(/query/);
    expect(await errOf("wiki_search", { query: "x".repeat(LIMITS.query) })).toBeNull();
    expect(await errOf("wiki_upsert", { id: "howto/big", title: "Big", summary: "Big.", tags: ["wiki"], body: "x".repeat(LIMITS.body + 1) })).toMatch(/body/);
    expect(await errOf("wiki_patch_section", { id: "howto/add-wiki-page-manually", section: "Pitfalls", content: "x".repeat(LIMITS.body + 1) })).toMatch(/content/);
    expect(await errOf("wiki_patch_section", { id: "howto/add-wiki-page-manually", section: "x".repeat(LIMITS.short + 1), content: "y" })).toMatch(/section/);
    expect(await errOf("wiki_upsert", { id: "howto/big", title: "x".repeat(LIMITS.short + 1), summary: "Big.", tags: ["wiki"], body: "y" })).toMatch(/title/);
  });
});
