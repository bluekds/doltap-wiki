import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSET_MAX_BYTES, addAsset, assetLinkFor, lintAll, listAssets, resolveConfig, WikiDb, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, sh } from "../../core/test/helpers.js";

/** 0.8 attachment policy: files live in wiki/_assets/<page id>/<file>, pages link them with a relative markdown link, lint keeps them honest. */
const howto = (link: string) => `---
title: With attachment
category: howto
summary: A page that carries a diagram.
tags: [wiki]
confidence: draft
created: 2026-11-03
updated: 2026-11-03
sources: []
---

## Prerequisites

x

## Steps

1. See ${link}

## Verification

z

## Pitfalls

- w

## Related

- [[howto/_index]]
`;

describe("attachments (0.8)", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let cfg: WikiConfig;
  const assets = () => join(cfg.wikiDir, "_assets");
  const put = (rel: string, content: string | Buffer) => { mkdirSync(join(assets(), rel, ".."), { recursive: true }); writeFileSync(join(assets(), rel), content); };
  const rulesFor = (id: string) => lintAll(cfg).filter((i) => i.id === id).map((i) => `${i.level}:${i.rule}`);
  beforeEach(() => {
    m = makeTwoMachines();
    cfg = resolveConfig({ root: m.a, noSync: true, agent: "test" });
  });
  afterEach(() => m.cleanup());

  it("assetLinkFor builds the relative link from the page's directory", () => {
    expect(assetLinkFor("howto/with-attachment", "diagram.png")).toBe("../_assets/howto/with-attachment/diagram.png");
    expect(assetLinkFor("projects/autosign/overview", "topology.svg")).toBe("../../_assets/projects/autosign/overview/topology.svg");
  });

  it("a linked asset that exists passes; a missing one is an error; an unreferenced one is an orphan warning", () => {
    put("howto/with-attachment/diagram.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    put("howto/with-attachment/unused.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(cfg.wikiDir, "howto/with-attachment.md"), howto("![diagram](../_assets/howto/with-attachment/diagram.png) and [gone](../_assets/howto/with-attachment/gone.pdf)"));
    expect(rulesFor("howto/with-attachment")).toContain("error:asset-missing");
    expect(rulesFor("howto/with-attachment").filter((r) => r.includes("asset"))).toHaveLength(1);
    expect(rulesFor("_assets/howto/with-attachment/unused.png")).toEqual(["warning:asset-orphan"]);
    expect(rulesFor("_assets/howto/with-attachment/diagram.png")).toEqual([]);
  });

  it("size cap and file type are warnings; a text asset is scanned for secrets like a page", () => {
    put("howto/with-attachment/big.bin", Buffer.alloc(ASSET_MAX_BYTES + 1));
    put("howto/with-attachment/notes.txt", "token: " + "ghp_" + "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eFgH1jK4\n");
    writeFileSync(join(cfg.wikiDir, "howto/with-attachment.md"), howto("[big](../_assets/howto/with-attachment/big.bin) [notes](../_assets/howto/with-attachment/notes.txt)"));
    const page = rulesFor("howto/with-attachment");
    expect(page).toContain("warning:asset-too-large");
    expect(page).toContain("warning:asset-type");
    const notes = rulesFor("_assets/howto/with-attachment/notes.txt");
    expect(notes).toContain("error:secret");
    expect(notes).not.toContain("warning:asset-orphan");
    expect(ASSET_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it("a markdown file under _assets is not a page", () => {
    put("howto/with-attachment/export.md", "# not a page\n");
    const db = new WikiDb(cfg);
    try { db.reindex(); expect(db.allIds().has("_assets/howto/with-attachment/export")).toBe(false); } finally { db.close(); }
    expect(lintAll(cfg).filter((i) => i.rule === "frontmatter-invalid")).toEqual([]);
  });

  it("addAsset copies the file next to its page, commits it, and returns the link to paste; the cap needs --force", () => {
    const src = join(m.a, "diagram.png");
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(cfg.wikiDir, "howto/with-attachment.md"), howto("nothing yet"));
    sh(m.a, "git", ["add", "-A"]); sh(m.a, "git", ["commit", "-qm", "page"]);
    const r = addAsset(cfg, { id: "howto/with-attachment", file: src });
    expect(r.link).toBe("![diagram](../_assets/howto/with-attachment/diagram.png)");
    expect(existsSync(join(assets(), "howto/with-attachment/diagram.png"))).toBe(true);
    expect(sh(m.a, "git", ["log", "-1", "--format=%s"])).toBe("wiki: asset howto/with-attachment diagram.png");
    expect(sh(m.a, "git", ["status", "--porcelain"])).toBe("");
    expect(() => addAsset(cfg, { id: "howto/with-attachment", file: src })).toThrow(/already exists/);
    expect(() => addAsset(cfg, { id: "howto/nope", file: src })).toThrow(/no page/);
    const big = join(m.a, "big.pdf"); writeFileSync(big, Buffer.alloc(ASSET_MAX_BYTES + 1));
    expect(() => addAsset(cfg, { id: "howto/with-attachment", file: big })).toThrow(/larger than/);
    expect(addAsset(cfg, { id: "howto/with-attachment", file: big, force: true }).link).toBe("[big.pdf](../_assets/howto/with-attachment/big.pdf)");
    const list = listAssets(cfg);
    expect(list.map((a) => a.path).sort()).toEqual(["howto/with-attachment/big.pdf", "howto/with-attachment/diagram.png"]);
    expect(list.find((a) => a.path.endsWith("big.pdf"))).toMatchObject({ referencedBy: [], bytes: ASSET_MAX_BYTES + 1 });
    expect(readFileSync(join(cfg.wikiDir, "howto/with-attachment.md"), "utf8")).toContain("nothing yet");
  });
});
