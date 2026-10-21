import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, type WikiConfig } from "../src/index.js";

/** Frozen copy of wiki/ under test/fixtures. Decoupled from the live wiki so promotions, stats and new
 *  pages in the real repo cannot change test outcomes. Refresh deliberately with:
 *  rsync -a --exclude _meta/stats --exclude _meta/index.md --exclude .obsidian wiki/ packages/core/test/fixtures/wiki/ */
export const SEED_ROOT = fileURLToPath(new URL("./fixtures/", import.meta.url));

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

export interface Fixture {
  dir: string;
  cleanup: () => void;
}

/** Copy wiki/ without per-host stats so fixtures stay hermetic regardless of what the live repo has. */
function copyWiki(dest: string): void {
  cpSync(join(SEED_ROOT, "wiki"), dest, { recursive: true, filter: (src) => !src.includes(`${sep}_meta${sep}stats`) });
}

/** Copy wiki/ into a fresh temp dir (no git). */
export function makeWikiCopy(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "doltap-"));
  copyWiki(join(dir, "wiki"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function cfgFor(dir: string, extra: Partial<WikiConfig> = {}): WikiConfig {
  return { ...resolveConfig({ root: dir, noSync: true, agent: "test" }), ...extra };
}

/**
 * Two "machines" (clones A and B) sharing one bare remote, both seeded with wiki/.
 */
export function makeTwoMachines(): { bare: string; a: string; b: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "doltap-sync-"));
  const bare = join(base, "remote.git");
  sh(base, "git", ["init", "--bare", "-q", "-b", "main", bare]);
  const seed = join(base, "seed");
  sh(base, "git", ["init", "-q", "-b", "main", seed]);
  copyWiki(join(seed, "wiki"));
  cpSync(fileURLToPath(new URL("../../../.gitignore", import.meta.url)), join(seed, ".gitignore"));
  // A tracked non-wiki file, so tests can simulate `npm install` dirtying the lockfile on a client machine.
  writeFileSync(join(seed, "package-lock.json"), "{\n  \"version\": \"seed\"\n}\n");
  sh(seed, "git", ["add", "-A"]);
  sh(seed, "git", ["commit", "-q", "-m", "seed"]);
  sh(seed, "git", ["remote", "add", "origin", bare]);
  sh(seed, "git", ["push", "-q", "-u", "origin", "main"]);
  const a = join(base, "a");
  const b = join(base, "b");
  sh(base, "git", ["clone", "-q", bare, a]);
  sh(base, "git", ["clone", "-q", bare, b]);
  for (const d of [a, b]) {
    sh(d, "git", ["config", "user.name", "t"]);
    sh(d, "git", ["config", "user.email", "t@t"]);
  }
  return { bare, a, b, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
