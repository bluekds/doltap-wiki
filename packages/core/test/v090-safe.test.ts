import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addTag, audit, getTemplate, lintAll, listSymlinks, loadTags, protocolText, publishHostStats, readPage, resolveConfig, safePath, syncAll, upsertPage, WikiDb, writeAuditReport, writeIndexMd,
  type WikiConfig,
} from "../src/index.js";
import { cfgFor, makeTwoMachines, makeWikiCopy, sh, type Fixture } from "./helpers.js";

/**
 * 0.9 security audit S1/S3/H2: a symlink anywhere under the root (pages, _meta, _assets, .doltap) is
 * never read through and never written through. Every read and write resolves its path with safePath,
 * which lstats each component below the root; lint reports every symlink in the tree.
 */
const howto = (n: string) => `## Prerequisites\n\n${n}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;
const ORIGINAL = "export PATH=$PATH\n";

describe("safePath", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeWikiCopy(); });
  afterEach(() => fx.cleanup());

  it("accepts regular paths, refuses symlinked components and paths outside the root", () => {
    const cfg = cfgFor(fx.dir);
    expect(safePath(cfg.root, join("wiki", "howto", "add-wiki-page-manually.md"))).toBe(join(cfg.root, "wiki", "howto", "add-wiki-page-manually.md"));
    expect(safePath(cfg.root, join(cfg.root, "wiki", "new-dir", "new.md"))).toBe(join(cfg.root, "wiki", "new-dir", "new.md"));
    const outside = join(fx.dir, "..", `outside-${process.pid}.txt`);
    writeFileSync(outside, ORIGINAL);
    try {
      symlinkSync(outside, join(cfg.wikiDir, "howto", "link.md"));
      symlinkSync(join("..", "..", ".."), join(cfg.wikiDir, "updir"));
      expect(() => safePath(cfg.root, "wiki/howto/link.md")).toThrow(/symbolic link/);
      expect(() => safePath(cfg.root, "wiki/updir/anything.md")).toThrow(/symbolic link/);
      expect(() => safePath(cfg.root, "../x")).toThrow(/outside/);
      expect(() => safePath(cfg.root, "/etc/passwd")).toThrow(/outside/);
      expect(listSymlinks(cfg.root).sort()).toEqual(["wiki/howto/link.md", "wiki/updir"]);
    } finally { rmSync(outside, { force: true }); }
  });
});

describe("a symlink pushed through the remote cannot make this machine read or write outside the wiki", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  let B: WikiConfig;
  let outside: string;
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "attacker", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
    B = { ...resolveConfig({ root: m.b, agent: "victim", session: "sess-b" }), hostname: "machine-b", autoPullMinutes: 0 };
    outside = join(m.b, "..", `victim-${process.pid}.txt`);
    writeFileSync(outside, ORIGINAL);
  });
  afterEach(() => { rmSync(outside, { force: true }); m.cleanup(); });

  /** The attacker commits symlinks (relative, so they resolve on the victim's clone) and pushes. */
  const plant = (links: Record<string, string>) => {
    for (const [rel, target] of Object.entries(links)) {
      const p = join(m.a, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      if (existsSync(p)) rmSync(p);
      symlinkSync(target, p);
    }
    sh(m.a, "git", ["add", "-f", ...Object.keys(links)]);
    sh(m.a, "git", ["commit", "-qm", "wiki: plant"]);
    sh(m.a, "git", ["push", "-q"]);
    syncAll(B);
    for (const rel of Object.keys(links)) expect(lstatSync(join(m.b, rel)).isSymbolicLink()).toBe(true);
  };
  const up = join("..", "..", "..", `victim-${process.pid}.txt`); // from wiki/_meta/<file>
  const upFromReports = join("..", up);

  it("generated files: index.md is recreated as a regular file; reports and stats refuse", () => {
    plant({ "wiki/_meta/index.md": up, "wiki/_meta/reports/2026-11-04.md": upFromReports, "wiki/_meta/stats/machine-b.json": upFromReports });
    // A page whose summary carries a newline is what turns an index line into a shell line.
    writeFileSync(join(m.a, "wiki", "howto", "evil.md"), `---\ntitle: Evil\ncategory: howto\nsummary: "ok\\necho INJECTED\\n"\ntags: [wiki]\nconfidence: draft\ncreated: 2026-11-03\nupdated: 2026-11-03\nsources: []\n---\n\n${howto("e")}`);
    sh(m.a, "git", ["add", "-A"]); sh(m.a, "git", ["commit", "-qm", "wiki: evil"]); sh(m.a, "git", ["push", "-q"]);
    syncAll(B);
    writeIndexMd(B);
    expect(readFileSync(outside, "utf8")).toBe(ORIGINAL);
    expect(lstatSync(join(m.b, "wiki", "_meta", "index.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(m.b, "wiki", "_meta", "index.md"), "utf8")).toContain("# Index");
    // Another host's planted stats file is skipped by audit, not fatal; this host's own file refuses the write.
    const r = { ...audit(B), generated: "2026-11-04T01:00:00.000Z" };
    expect(() => writeAuditReport(B, r)).toThrow(/symbolic link/);
    expect(readFileSync(outside, "utf8")).toBe(ORIGINAL);
    const db = new WikiDb(B);
    try {
      db.reindex();
      db.logAccess?.("howto/add-wiki-page-manually");
      expect(() => publishHostStats(B, db, { pulled: false, pushed: false, conflicts: [], messages: [] }, 0)).toThrow(/symbolic link/);
    } finally { db.close(); }
    expect(readFileSync(outside, "utf8")).toBe(ORIGINAL);
    const rules = lintAll(B).filter((i) => i.rule === "symlink").map((i) => i.message.split(" ")[0]).sort();
    // index.md was replaced by a regular file above; the other two links remain and are reported.
    expect(rules).toEqual(["_meta/reports/2026-11-04.md", "_meta/stats/machine-b.json"].map((p) => `wiki/${p}`));
  });

  it("vocabulary, templates and protocol: reads and writes refuse instead of following the link", () => {
    writeFileSync(outside, "f".repeat(64) + "\n");
    plant({ "wiki/_meta/tags.yaml": up, "wiki/_meta/templates/reference.md": upFromReports, "wiki/_meta/PROTOCOL.md": up });
    expect(() => loadTags(B)).toThrow(/symbolic link/);
    expect(() => addTag(B, { tag: "newtag", description: "A new tag", group: "domain" })).toThrow(/symbolic link/);
    expect(() => getTemplate(B, "reference")).toThrow(/symbolic link/);
    expect(() => protocolText(B)).toThrow(/symbolic link/);
    expect(readFileSync(outside, "utf8")).toBe("f".repeat(64) + "\n");
  });

  it("pages: a planted page path is neither read nor written through, and a symlinked directory is skipped", () => {
    plant({ "wiki/howto/planted.md": join("..", up), "wiki/cl": join("..", "..") });
    expect(readPage(B, "howto/planted")).toBeNull();
    expect(readPage(B, "cl/README")).toBeNull();
    expect(() => upsertPage(B, { id: "howto/planted", title: "Planted", summary: "Planted.", tags: ["wiki"], body: howto("p"), force: true })).toThrow(/symbolic link/);
    expect(readFileSync(outside, "utf8")).toBe(ORIGINAL);
    expect(lstatSync(join(m.b, "wiki", "howto", "planted.md")).isSymbolicLink()).toBe(true);
    const found = lintAll(B).filter((i) => i.rule === "symlink").map((i) => i.message.split(" ")[0]).sort();
    expect(found).toEqual(["wiki/cl", "wiki/howto/planted.md"]);
  });
});
