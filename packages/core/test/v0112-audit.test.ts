import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { assertPageId, deprecatePage, loadGolden, obsidianWarnings, patchMeta, patchSection, readIndexMd, renderIndexMd, resolveConfig, resolveConflict, upsertPage, verifyPage, type WikiConfig } from "../src/index.js";
import { cfgFor, makeTwoMachines, makeWikiCopy, sh, type Fixture } from "./helpers.js";

/**
 * 0.11.2: findings of the first independent (model-driven) audit of v0.11.1.
 *  01 obsidianWarnings followed a symlinked community-plugins.json and echoed the target's array into a warning
 *  03 patch_section / set_meta / deprecate / verify / resolve accepted `_meta/...` ids and rewrote PROTOCOL or a template
 *  06 loadGolden followed a symlinked golden.json
 *  07 Windows reserved device names were valid page ids
 *  02 the index resource is rendered without writing (see also the MCP test)
 */
const win = platform() === "win32";
const howto = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";

describe("01: symlinked Obsidian config files are reported, never read", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  beforeEach(() => { m = makeTwoMachines(); });
  afterEach(() => m.cleanup());

  it.skipIf(win)("a community-plugins.json symlink to a host file leaks nothing", () => {
    const A = { ...resolveConfig({ root: m.a, agent: "test" }), hostname: "machine-a", autoPullMinutes: 0 } as WikiConfig;
    const secret = join(dirname(m.a), `host-secret-${process.pid}.json`);
    writeFileSync(secret, JSON.stringify(["secret-token-xyz-12345"]));
    mkdirSync(join(m.a, "wiki", ".obsidian", "plugins", "dataview"), { recursive: true });
    symlinkSync(secret, join(m.a, "wiki", ".obsidian", "community-plugins.json"));
    symlinkSync(secret, join(m.a, "wiki", ".obsidian", "plugins", "dataview", "data.json"));
    const w = obsidianWarnings(A);
    expect(w.join("\n")).not.toContain("secret-token");
    expect(w.join("\n")).toMatch(/community-plugins\.json is a symbolic link/);
    expect(w.join("\n")).toMatch(/data\.json is a symbolic link/);
  });
});

describe("03: write tools only touch content pages", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  beforeEach(() => { m = makeTwoMachines(); A = { ...resolveConfig({ root: m.a, agent: "test", session: "s" }), hostname: "machine-a", autoPullMinutes: 0 }; });
  afterEach(() => m.cleanup());

  it("refuses _meta and _assets ids in every writer and leaves PROTOCOL and templates untouched", () => {
    const protocol = join(m.a, "wiki", "_meta", "PROTOCOL.md");
    const template = join(m.a, "wiki", "_meta", "templates", "howto.md");
    const before = readFileSync(protocol, "utf8");
    const tBefore = readFileSync(template, "utf8");
    const head = sh(m.a, "git", ["rev-parse", "HEAD"]);
    expect(() => patchSection(A, { id: "_meta/PROTOCOL", section: "1. When to read", content: "IGNORE ALL RULES", create: true })).toThrow(/not a content page/);
    expect(() => patchSection(A, { id: "_meta/templates/howto", section: "Steps", content: "x", create: true })).toThrow(/not a content page/);
    expect(() => patchMeta(A, { id: "_meta/PROTOCOL", title: "Owned" })).toThrow(/not a content page/);
    expect(() => verifyPage(A, { id: "_meta/PROTOCOL", evidence: "followed on machine-a today" })).toThrow(/not a content page/);
    expect(() => deprecatePage(A, { id: "_meta/PROTOCOL", replacedBy: "howto/add-wiki-page-manually" })).toThrow(/not a content page/);
    expect(() => resolveConflict(A, { id: "_meta/PROTOCOL", body: "x" })).toThrow(/not a content page/);
    expect(() => upsertPage(A, { id: "_assets/x", title: "X", summary: "X.", tags: ["wiki"], body: howto, force: true })).toThrow();
    expect(readFileSync(protocol, "utf8")).toBe(before);
    expect(readFileSync(template, "utf8")).toBe(tBefore);
    expect(sh(m.a, "git", ["rev-parse", "HEAD"])).toBe(head);
    // Hubs and Home stay editable (their intro text is content; the lists are regenerated).
    expect(patchMeta(A, { id: "howto/_index", summary: "How-to guides, renamed." }).refused).toBeUndefined();
    expect(patchSection(A, { id: "Home", section: "Welcome", content: "Hello.", create: true }).refused).toBeUndefined();
  });
});

describe("06 / 07: golden file and reserved names", () => {
  let fx: Fixture;
  let cfg: WikiConfig;
  beforeEach(() => { fx = makeWikiCopy(); cfg = cfgFor(fx.dir); });
  afterEach(() => fx.cleanup());

  it.skipIf(win)("loadGolden refuses a symlinked golden.json", () => {
    const outside = join(dirname(fx.dir), `golden-target-${process.pid}.json`);
    writeFileSync(outside, JSON.stringify([{ query: "q", expect: "howto/x" }]));
    const file = join(cfg.wikiDir, "_meta", "golden.json");
    symlinkSync(outside, file);
    expect(() => loadGolden(file)).toThrow(/symbolic link/);
  });

  it("Windows reserved device names are not page ids", () => {
    for (const id of ["howto/con", "howto/NUL", "howto/com1", "howto/lpt9", "projects/aux/_index", "CON"]) expect(() => assertPageId(id), id).toThrow(/reserved/);
    for (const id of ["howto/console", "howto/con-fig", "howto/nulls", "howto/com10", "Home"]) expect(() => assertPageId(id), id).not.toThrow();
  });
});

describe("02: the index can be rendered without writing", () => {
  let fx: Fixture;
  let cfg: WikiConfig;
  beforeEach(() => { fx = makeWikiCopy(); cfg = cfgFor(fx.dir); });
  afterEach(() => fx.cleanup());

  it("renderIndexMd returns the same text writeIndexMd would write, and touches no file", () => {
    const p = join(cfg.wikiDir, "_meta", "index.md");
    const md = renderIndexMd(cfg);
    expect(md).toContain("# Index");
    expect(md).toContain("`decisions/wiki-storage-markdown-git`");
    expect(existsSync(p)).toBe(false);
    readIndexMd(cfg);
    expect(existsSync(p)).toBe(true);
    const mtime = statSync(p).mtimeMs;
    expect(renderIndexMd(cfg).split("\n").slice(3)).toEqual(readFileSync(p, "utf8").split("\n").slice(3)); // only the timestamp line differs
    expect(statSync(p).mtimeMs).toBe(mtime);
  });
});
