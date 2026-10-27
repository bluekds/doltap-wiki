import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { makeWikiCopy, type Fixture } from "../../core/test/helpers.js";

let fx: Fixture;
let client: Client;

beforeAll(async () => {
  fx = makeWikiCopy();
  const server = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, DOLTAP_ROOT: fx.dir, DOLTAP_NO_SYNC: "1", DOLTAP_AGENT: "test" } as Record<string, string> }));
});
afterAll(async () => { await client.close(); fx.cleanup(); });

const parse = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0].text);

describe("mcp server", () => {
  it("exposes tools and resources", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["wiki_add_tag", "wiki_audit", "wiki_deprecate", "wiki_get", "wiki_history", "wiki_lint", "wiki_list", "wiki_patch_section", "wiki_related", "wiki_resolve_conflict", "wiki_search", "wiki_set_meta", "wiki_sync", "wiki_template", "wiki_upsert", "wiki_verify"]);
    const res = (await client.listResources()).resources.map((r) => r.uri).sort();
    expect(res).toEqual(["wiki://index", "wiki://protocol", "wiki://tags"]);
    const proto = await client.readResource({ uri: "wiki://protocol" });
    expect(proto.contents[0].text).toContain("# Doltap Protocol");
  });

  it("searches and reads a section", async () => {
    const s = parse(await client.callTool({ name: "wiki_search", arguments: { query: "obsidian backlinks" } }));
    expect(s.hits[0].id).toBe("reference/obsidian-conventions");
    const g = parse(await client.callTool({ name: "wiki_get", arguments: { id: "decisions/wiki-storage-markdown-git", section: "Decision" } }));
    expect(g.text).toMatch(/^Markdown \+ git/);
    expect(g.sections).toContain("Consequences");
  });

  it("creates, patches, promotes a page and rejects bad input", async () => {
    const tpl = (await client.callTool({ name: "wiki_template", arguments: { category: "patterns" } })).content as { text: string }[];
    const body = tpl[0].text.split("---").slice(2).join("---").replace(/^\n+/, "").replace("What this pattern solves. When it is needed and when it is overkill.", "Flaky upstream calls.").replace(/\n\n(##|$)/g, "\n\nN/A\n\n$1");
    const up = parse(await client.callTool({ name: "wiki_upsert", arguments: { id: "patterns/retry-backoff", title: "Exponential backoff retry", summary: "Retry transient failures with capped exponential backoff and jitter.", tags: ["api"], body, force: true } }));
    expect(up.created).toBe(true);
    const bad = await client.callTool({ name: "wiki_upsert", arguments: { id: "patterns/other", title: "T", summary: "S", tags: ["nope"], body, force: true } });
    expect(bad.isError).toBe(true);
    expect(parse(bad).issues.map((i: { rule: string }) => i.rule)).toContain("tag-unknown");
    const p = parse(await client.callTool({ name: "wiki_patch_section", arguments: { id: "patterns/retry-backoff", section: "Anti-patterns", content: "- retrying non-idempotent writes", mode: "append" } }));
    expect(p.id).toBe("patterns/retry-backoff");
    const notAllowed = await client.callTool({ name: "wiki_set_meta", arguments: { id: "patterns/retry-backoff", confidence: "verified" } }).catch((e: Error) => e);
    expect(String(notAllowed instanceof Error ? notAllowed.message : JSON.stringify(notAllowed))).toMatch(/draft|invalid/i);
    const m = parse(await client.callTool({ name: "wiki_verify", arguments: { id: "patterns/retry-backoff", evidence: "Followed on machine-t 2026-10-27; worked" } }));
    expect(m.id).toBe("patterns/retry-backoff");
    const g = parse(await client.callTool({ name: "wiki_get", arguments: { id: "patterns/retry-backoff" } }));
    expect(g.meta.confidence).toBe("verified");
    expect(g.meta.sources).toContain("Followed on machine-t 2026-10-27; worked");
    expect(g.text).toContain("retrying non-idempotent writes");
    const rel = parse(await client.callTool({ name: "wiki_related", arguments: { id: "patterns/retry-backoff" } }));
    expect(Array.isArray(rel.backlinks)).toBe(true);
  });
});
