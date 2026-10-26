import { afterAll, describe, expect, it } from "vitest";
import { extractLinks, replaceSection, serializePage, splitSections, normalizeMeta, parsePage, idFromRelPath } from "../src/page.js";
import { cfgFor, makeWikiCopy } from "./helpers.js";

const fx = makeWikiCopy();
afterAll(() => fx.cleanup());

const body = `## Prerequisites

Need git.

## Steps

1. do it

\`\`\`sh
## not a heading
\`\`\`

## Pitfalls

- none

## Related

- [[howto/_index]]
- [[reference/obsidian-conventions#Key facts]]
- [[decisions/wiki-storage-markdown-git|alias]]
`;

describe("page parsing", () => {
  it("normalizes CRLF input and backslash paths (Windows checkouts)", () => {
    const cfg = cfgFor(fx.dir);
    const crlf = "---\r\ntitle: T\r\ncategory: howto\r\nsummary: S\r\ntags: [git]\r\nconfidence: draft\r\ncreated: 2026-10-18\r\nupdated: 2026-10-18\r\nsources: []\r\n---\r\n\r\n## Steps\r\n\r\n1. x\r\n\r\n## Related\r\n\r\n- [[howto/_index]]\r\n";
    const page = parsePage(cfg, "howto\\x.md", crlf);
    expect(page.id).toBe("howto/x");
    expect(page.meta.title).toBe("T");
    expect(page.sections.map((s) => s.heading)).toEqual(["Steps", "Related"]);
    expect(page.sections[0].content).toBe("1. x");
    expect(page.links).toEqual(["howto/_index"]);
    expect(page.raw).not.toContain("\r");
    expect(idFromRelPath("patterns\\retry-backoff.md")).toBe("patterns/retry-backoff");
  });

  it("extracts wikilinks, ignoring section and alias parts", () => {
    expect(extractLinks(body)).toEqual(["howto/_index", "reference/obsidian-conventions", "decisions/wiki-storage-markdown-git"]);
  });

  it("ignores links inside inline code and fences", () => {
    expect(extractLinks("use `[[cat/slug]]` and\n```\n[[x/y]]\n```\n[[howto/_index]]")).toEqual(["howto/_index"]);
  });

  it("splits sections and ignores headings inside code fences", () => {
    const s = splitSections(body);
    expect(s.map((x) => x.heading)).toEqual(["Prerequisites", "Steps", "Pitfalls", "Related"]);
    expect(s[1].content).toContain("## not a heading");
    expect(s[0].content).toBe("Need git.");
  });

  it("replaces a section in place", () => {
    const out = replaceSection(body, "Pitfalls", "- watch out");
    expect(out).toContain("## Pitfalls\n\n- watch out\n\n## Related");
    expect(out).not.toContain("- none");
    expect(splitSections(out).map((x) => x.heading)).toEqual(["Prerequisites", "Steps", "Pitfalls", "Related"]);
  });

  it("appends to a section and creates missing sections", () => {
    const appended = replaceSection(body, "Pitfalls", "- second", "append");
    expect(appended).toContain("- none\n\n- second");
    expect(() => replaceSection(body, "Changelog", "- 2026-10-18 fixed")).toThrow(/not found/);
    const created = replaceSection(body, "Changelog", "- 2026-10-18 fixed", "replace", { create: true });
    expect(created.trimEnd().endsWith("## Changelog\n\n- 2026-10-18 fixed")).toBe(true);
  });

  it("serializes frontmatter with stable key order and plain dates", () => {
    const meta = normalizeMeta({ updated: "2026-10-18", title: "T", category: "howto", summary: "S", tags: ["git"], confidence: "draft", created: new Date("2026-10-18"), sources: [] });
    const raw = serializePage(meta, "## Steps\n\n1. x\n");
    expect(raw.startsWith("---\ntitle: T\ncategory: howto\nsummary: S\ntags:\n  - git\nconfidence: draft\ncreated: 2026-10-18\nupdated: 2026-10-18\nsources: []\n---\n")).toBe(true);
  });
});
