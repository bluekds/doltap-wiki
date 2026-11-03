import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addAsset, addTag, audit, get, resolveConfig, search, syncAll, upsertPage, writeAuditReport, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, sh } from "./helpers.js";

/**
 * 0.9 audits H3, S8, S5/M4: attachments and tag descriptions go through the secret filter before they are
 * committed, and the committed audit report carries no search query text (queries stay on the machine).
 */
const howto = (n: string) => `## Prerequisites\n\n${n}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;
const GH = "ghp_" + "A".repeat(36); // concatenated so the literal never looks like a real token

describe("secret filter on the non-page write paths", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "a", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
    upsertPage(A, { id: "howto/asset-host", title: "Asset host", summary: "Host.", tags: ["wiki"], body: howto("h"), force: true });
  });
  afterEach(() => m.cleanup());

  it("a text attachment with a token is refused before anything is copied or committed", () => {
    const head = sh(m.a, "git", ["rev-parse", "HEAD"]);
    const creds = join(m.a, "..", `creds-${process.pid}.txt`);
    writeFileSync(creds, `token = ${GH}\n`);
    expect(() => addAsset(A, { id: "howto/asset-host", file: creds })).toThrow(/secret/);
    expect(() => addAsset(A, { id: "howto/asset-host", file: creds, force: true })).toThrow(/secret/);
    expect(existsSync(join(m.a, "wiki", "_assets", "howto", "asset-host", `creds-${process.pid}.txt`))).toBe(false);
    expect(sh(m.a, "git", ["rev-parse", "HEAD"])).toBe(head);
  });

  it("a tag description with a token is refused", () => {
    expect(() => addTag(A, { tag: "newtag", description: `use ${GH} for this`, group: "domain" })).toThrow(/secret/);
    expect(readFileSync(join(m.a, "wiki", "_meta", "tags.yaml"), "utf8")).not.toContain("newtag");
  });

  it("the committed audit report lists search misses without the query text", () => {
    search(A, "zebra-private-query-seventy-seven");
    get(A, "howto/add-wiki-page-manually");
    const r = audit(A);
    expect(r.searchMisses.some((x) => x.query.includes("zebra-private-query"))).toBe(true);
    const w = writeAuditReport(A, r);
    const md = readFileSync(join(m.a, w.file), "utf8");
    expect(md).toContain("## Search misses");
    expect(md).toContain("howto/add-wiki-page-manually");
    expect(md).not.toContain("zebra-private-query");
    expect(sh(m.a, "git", ["status", "--porcelain"])).toBe("");
  });
});
