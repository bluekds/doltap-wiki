import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiDb, hasErrors, lintOne, readPage, scaffoldWiki } from "../src/index.js";
import { cfgFor, sh } from "./helpers.js";

describe("scaffoldWiki", () => {
  it("creates a lint-clean wiki with one commit and refuses to overwrite", () => {
    const base = mkdtempSync(join(tmpdir(), "doltap-scaffold-"));
    try {
      const dir = join(base, "kb");
      const r = scaffoldWiki(dir);
      expect(r.pushed).toBeNull();
      for (const f of ["wiki/_meta/PROTOCOL.md", "wiki/_meta/tags.yaml", "wiki/Home.md", "wiki/howto/_index.md", "wiki/.obsidian/app.json", ".gitignore", ".gitattributes"]) {
        expect(existsSync(join(dir, f)), f).toBe(true);
      }
      expect(existsSync(join(dir, "dot.gitignore"))).toBe(false);
      expect(readFileSync(join(dir, "wiki/Home.md"), "utf8")).not.toContain("2026-10-18");
      expect(sh(dir, "git", ["rev-list", "--count", "HEAD"])).toBe("1");
      expect(sh(dir, "git", ["status", "--porcelain"])).toBe("");
      const cfg = cfgFor(dir);
      const db = new WikiDb(cfg);
      db.reindex(true);
      const ids = db.allIds();
      expect(ids.size).toBeGreaterThan(5);
      for (const id of ids) {
        const page = readPage(cfg, id)!;
        expect(hasErrors(lintOne(cfg, db, page)), id).toBe(false);
      }
      db.close();
      expect(() => scaffoldWiki(dir)).toThrow(/already exists/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("adds the remote and pushes when one is given", () => {
    const base = mkdtempSync(join(tmpdir(), "doltap-scaffold-remote-"));
    try {
      const bare = join(base, "remote.git");
      sh(base, "git", ["init", "--bare", "-q", "-b", "main", bare]);
      const r = scaffoldWiki(join(base, "kb"), { remote: bare });
      expect(r.pushed).toBe(true);
      expect(sh(bare, "git", ["rev-list", "--count", "main"])).toBe("1");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
