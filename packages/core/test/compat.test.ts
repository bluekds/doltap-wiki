import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { patchMeta, patchSection, readPage, resolveConfig, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, sh } from "./helpers.js";

/**
 * docs/COMPATIBILITY.md section 2: a frontmatter field this version does not know (written by a newer 1.x on
 * another machine) survives this version's edits, so machines on different minor versions share one wiki.
 */
describe("unknown frontmatter fields survive edits", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  const id = "howto/add-wiki-page-manually";
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "test", session: "s" }), hostname: "machine-a", autoPullMinutes: 0 };
    const f = join(A.wikiDir, `${id}.md`);
    writeFileSync(f, readFileSync(f, "utf8").replace("\ntitle:", "\nfuture_field: keep-me\nfuture_list: [a, b]\ntitle:"));
    sh(m.a, "git", ["commit", "-qam", "a newer version wrote fields this one does not know"]);
  });
  afterEach(() => m.cleanup());

  it("patch_section and set_meta keep them", () => {
    expect(patchSection(A, { id, section: "Pitfalls", content: "- edited by an older version" }).refused).toBeUndefined();
    expect(patchMeta(A, { id, summary: "Summary rewritten by an older version of doltap, keeping unknown fields." }).refused).toBeUndefined();
    const raw = readFileSync(join(A.wikiDir, `${id}.md`), "utf8");
    expect(raw).toContain("future_field: keep-me");
    expect(raw).toMatch(/future_list:\s*(\[a, b\]|\n\s*- a\n\s*- b)/);
    expect(readPage(A, id)!.body).toContain("edited by an older version");
  });
});
