import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addAsset, lintAll, obsidianWarnings, resolveConfig, runGolden, type WikiConfig } from "../src/index.js";
import { cfgFor, makeTwoMachines, makeWikiCopy, removeTemp, type Fixture } from "./helpers.js";

/**
 * 0.13.2: findings of the second independent audit (v0.13.1).
 *  01 a symlinked `.obsidian` (or `.obsidian/plugins`) directory bypassed the 0.11.2 leaf check: the host's JSON was echoed into the warning
 *  02 a symlinked `_meta` directory bypassed the 0.11.2 leaf check in loadGolden
 *  04 Windows reserved device names were accepted as attachment names (`con.png`)
 */
const win = platform() === "win32";

describe("01: symlinked directories under .obsidian are reported, never read", () => {
  let fx: Fixture;
  let cfg: WikiConfig;
  let outside: string;
  beforeEach(() => {
    fx = makeWikiCopy();
    cfg = cfgFor(fx.dir);
    outside = mkdtempSync(join(tmpdir(), "doltap-host-"));
    writeFileSync(join(outside, "community-plugins.json"), JSON.stringify(["secret-token-xyz-12345"]));
    mkdirSync(join(outside, "dataview"), { recursive: true });
    writeFileSync(join(outside, "dataview", "data.json"), JSON.stringify({ enableDataviewJs: true }));
  });
  afterEach(() => { fx.cleanup(); removeTemp(outside); });

  it.skipIf(win)(".obsidian itself a symlink to a host directory", () => {
    rmSync(join(cfg.wikiDir, ".obsidian"), { recursive: true, force: true });
    symlinkSync(outside, join(cfg.wikiDir, ".obsidian"));
    const w = obsidianWarnings(cfg).join("\n");
    expect(w).not.toContain("secret-token");
    expect(w).toMatch(/\.obsidian is a symbolic link/);
  });

  it.skipIf(win)(".obsidian/plugins a symlink to a host directory", () => {
    mkdirSync(join(cfg.wikiDir, ".obsidian"), { recursive: true });
    rmSync(join(cfg.wikiDir, ".obsidian", "plugins"), { recursive: true, force: true });
    symlinkSync(outside, join(cfg.wikiDir, ".obsidian", "plugins"));
    const w = obsidianWarnings(cfg).join("\n");
    expect(w).not.toMatch(/enableDataviewJs is on/);
    expect(w).toMatch(/\.obsidian\/plugins is a symbolic link/);
  });
});

describe("02: golden.json behind a symlinked _meta directory", () => {
  let fx: Fixture;
  let cfg: WikiConfig;
  let outside: string;
  beforeEach(() => { fx = makeWikiCopy(); cfg = cfgFor(fx.dir); outside = mkdtempSync(join(tmpdir(), "doltap-host-")); });
  afterEach(() => { fx.cleanup(); removeTemp(outside); });

  it.skipIf(win)("runGolden refuses the wiki's golden set when _meta is a link", () => {
    writeFileSync(join(outside, "golden.json"), JSON.stringify([{ query: "host-secret-leaked-123", expect: "howto/x" }]));
    renameSync(join(cfg.wikiDir, "_meta"), join(dirname(cfg.wikiDir), "meta-moved"));
    symlinkSync(outside, join(cfg.wikiDir, "_meta"));
    expect(() => runGolden(cfg)).toThrow(/symbolic link/);
  });
});

describe("04: Windows reserved names in attachments", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  let src: string;
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "test", session: "s" }), hostname: "machine-a", autoPullMinutes: 0 };
    src = mkdtempSync(join(tmpdir(), "doltap-src-"));
  });
  afterEach(() => { m.cleanup(); removeTemp(src); });

  it("addAsset refuses con.png, NUL.txt, com1.tar.gz and a trailing dot; allows console.png", () => {
    for (const name of ["con.png", "NUL.txt", "com1.tar.gz", "Lpt9.svg", "aux", "logo."]) {
      writeFileSync(join(src, name), "x");
      expect(() => addAsset(A, { id: "howto/add-wiki-page-manually", file: join(src, name) }), name).toThrow(/reserved/);
    }
    writeFileSync(join(src, "console.png"), "x");
    expect(addAsset(A, { id: "howto/add-wiki-page-manually", file: join(src, "console.png") }).link).toContain("console.png");
  });

  it("lint reports a reserved attachment name that arrived through git", () => {
    const dir = join(A.wikiDir, "_assets", "howto", "add-wiki-page-manually");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "prn.png"), "x");
    const issues = lintAll(A).filter((i) => i.rule === "asset-reserved-name");
    expect(issues.map((i) => i.id)).toEqual(["_assets/howto/add-wiki-page-manually/prn.png"]);
    expect(issues[0].level).toBe("error");
  });
});
