import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assetRefsIn, extractLinks, findSecrets, PAGE_MAX_CHARS, parsePage, search, splitSections, stripCode, WikiDb } from "../src/index.js";
import { cfgFor, makeWikiCopy, type Fixture } from "./helpers.js";

/**
 * 0.9 security audit S4/S6: every regex that runs over page content or a search query must be linear.
 * A 3 KB heading line used to take 11 s to parse and stall the HTTP server; one 160 KB query took 43 s.
 */
const ms = (fn: () => unknown): number => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
const page = (body: string) => `---\ntitle: T\ncategory: howto\nsummary: s\ntags: [wiki]\nconfidence: draft\ncreated: 2026-11-03\nupdated: 2026-11-03\nsources: []\n---\n\n${body}`;
const cfg = { wikiDir: "/x" } as Parameters<typeof parsePage>[0];
const LIMIT_MS = 100;

describe("adversarial inputs parse in linear time", () => {
  it("heading line padded with 50 KB of spaces", () => {
    expect(ms(() => parsePage(cfg, "howto/t.md", page(`## Steps\n\n# a${" ".repeat(50_000)}b\n`)))).toBeLessThan(LIMIT_MS);
  });
  it("80 KB of [[ (links), ![ and []( (asset links)", () => {
    expect(ms(() => extractLinks("[[".repeat(40_000)))).toBeLessThan(LIMIT_MS);
    expect(ms(() => assetRefsIn("![".repeat(40_000), "/x/howto/p.md", "/x"))).toBeLessThan(LIMIT_MS);
    expect(ms(() => assetRefsIn("[](".repeat(27_000), "/x/howto/p.md", "/x"))).toBeLessThan(LIMIT_MS);
  });
  it("80 KB of token= (credential assignment) and 10,000 unclosed fences", () => {
    expect(ms(() => findSecrets("token=".repeat(13_000)))).toBeLessThan(LIMIT_MS);
    expect(ms(() => findSecrets(("token=" + "x".repeat(20) + "\n").repeat(3_000)))).toBeLessThan(LIMIT_MS);
    const fences = "```\n".repeat(10_000) + "[[howto/x]]\n";
    expect(ms(() => { stripCode(fences); splitSections(fences); })).toBeLessThan(LIMIT_MS);
  });
  it("a page over the size cap is refused by the parser, so it never reaches the index or a write", () => {
    expect(() => parsePage(cfg, "howto/t.md", page("## Steps\n\n" + "x".repeat(PAGE_MAX_CHARS)))).toThrow(/too large/);
  });
});

describe("the parser still reads markdown the way it did", () => {
  it("headings: closing hashes trimmed, `C#` kept, fences of the opening kind only, indented fences", () => {
    const s = splitSections("## Title ##\n\nx\n\n## Using C#\n\ny\n\n```\n~~~\n## not a heading\n```\n\n## Pitfalls\n\n- z\n");
    expect(s.map((x) => x.heading)).toEqual(["Title", "Using C#", "Pitfalls"]);
    expect(stripCode("a\n   ```js\n[[howto/in-code]]\n   ```\n[[howto/real]] `[[howto/inline]]`\n")).not.toContain("in-code");
    expect(extractLinks("a\n   ```js\n[[howto/in-code]]\n   ```\n[[howto/real]] `[[howto/inline]]`\n")).toEqual(["howto/real"]);
    // A longer closing fence closes a shorter opener; a shorter one does not.
    expect(extractLinks("````\n```\n[[howto/still-code]]\n````\n[[howto/after]]\n")).toEqual(["howto/after"]);
  });
  it("asset links inside code are examples, not attachments", () => {
    const refs = assetRefsIn("See `![d](../_assets/howto/p/d.png)` and ![real](../_assets/howto/p/real.png)\n", "/x/howto/p.md", "/x");
    expect(refs.map((r) => r.rel)).toEqual(["howto/p/real.png"]);
  });
  it("credential assignments: quoted 8+, unquoted 10+ with a digit and a letter, placeholders exempt", () => {
    expect(findSecrets('password = "hunter2hunter2"')).toContain("credential-assignment");
    expect(findSecrets("api_key: abc123def456ghi")).toContain("credential-assignment");
    expect(findSecrets("token: $TOKEN_FROM_ENV_1234")).toEqual([]);
    expect(findSecrets("token = <your-token-1234567>")).toEqual([]);
    expect(findSecrets("secret: justletters")).toEqual([]);
    expect(findSecrets("token=1234567890")).toEqual([]);
  });
});

describe("search queries are bounded", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeWikiCopy(); });
  afterEach(() => fx.cleanup());
  it("keeps at most 32 tokens and answers a 200 KB query quickly", () => {
    const q = Array.from({ length: 40_000 }, (_, i) => `word${i}`).join(" ");
    expect(WikiDb.queryTokens(q).length).toBeLessThanOrEqual(32);
    expect(ms(() => search(cfgFor(fx.dir), q))).toBeLessThan(500);
  });
});
