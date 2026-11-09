import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readPage, resolveConfig, type WikiConfig } from "@bluekds/doltap-core";
import { makeWikiCopy, type Fixture } from "../../core/test/helpers.js";
import { createServer } from "../src/server.js";

/** 0.13 over MCP: wiki_search returns coverage and unmatched_terms; wiki_upsert and wiki_set_meta take aliases. */
let fx: Fixture;
let cfg: WikiConfig;
let client: Client;
beforeAll(async () => {
  fx = makeWikiCopy();
  cfg = resolveConfig({ root: fx.dir, agent: "test", noSync: true });
  const server = createServer(cfg);
  client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
});
afterAll(async () => { await client.close(); fx.cleanup(); });
const json = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: JSON.parse((r.content as { text: string }[])[0].text) };
};
const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";

describe("wiki_search coverage", () => {
  it("reports coverage and the terms a hit does not contain", async () => {
    const r = await json("wiki_search", { query: "obsidian conventions zebrafish" });
    expect(r.isError).toBe(false);
    const hit = r.data.hits.find((h: { id: string }) => h.id === "reference/obsidian-conventions");
    expect(hit.unmatched_terms).toEqual(["zebrafish"]);
    expect(hit.coverage).toBeGreaterThan(0);
    expect(hit.coverage).toBeLessThan(1);
  });
});

describe("aliases over MCP", () => {
  it("wiki_upsert sets them and wiki_set_meta replaces them", async () => {
    const up = await json("wiki_upsert", { id: "howto/inference-box", title: "Call the inference box", summary: "Ports.", tags: ["api"], aliases: ["DGX Spark"], body, force: true });
    expect(up.isError).toBe(false);
    expect(readPage(cfg, "howto/inference-box")!.meta.aliases).toEqual(["DGX Spark"]);
    expect((await json("wiki_search", { query: "dgx spark" })).data.hits[0].id).toBe("howto/inference-box");
    expect((await json("wiki_set_meta", { id: "howto/inference-box", aliases: ["gb10", "ai-server"] })).isError).toBe(false);
    expect(readPage(cfg, "howto/inference-box")!.meta.aliases).toEqual(["gb10", "ai-server"]);
  });
});
