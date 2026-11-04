import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Files shipped with @bluekds/doltap-core; `dot.<name>` entries become `.<name>` on copy so npm packs them. */
const SKELETON_DIR = fileURLToPath(new URL("../skeleton/", import.meta.url));

export interface ScaffoldOptions {
  /** git remote to add as origin and push to (optional) */
  remote?: string;
  /** Set up inside a directory that already has files or a .git: skeleton files are copied, .gitignore lines merged, only the skeleton committed. */
  force?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  files: number;
  /** null when no remote was given */
  pushed: boolean | null;
  notes: string[];
}

function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The skeleton's files, relative to its root, in their shipped (`dot.`) spelling. */
function skeletonFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(dir, name)).isDirectory()) out.push(...skeletonFiles(join(dir, name), rel));
    else out.push(rel);
  }
  return out;
}

/** `dot.x` -> `.x` on every segment (skeleton files are stored without leading dots so npm packs them). */
const undotPath = (rel: string): string => rel.split("/").map((seg) => (seg.startsWith("dot.") ? seg.slice(3) : seg)).join("/");

/**
 * Copy the skeleton into `dir`, renaming only the copied `dot.*` entries: a user's own `dot.config` next to
 * the wiki is never touched. An existing .gitignore / .gitattributes keeps its lines and gains the skeleton's.
 * Returns the destination paths (relative, forward-slash) so the caller can stage exactly those.
 */
function copySkeleton(dir: string): string[] {
  const copied: string[] = [];
  for (const rel of skeletonFiles(SKELETON_DIR)) {
    const dest = undotPath(rel);
    const to = join(dir, dest);
    mkdirSync(dirname(to), { recursive: true });
    if ((dest === ".gitignore" || dest === ".gitattributes") && existsSync(to)) {
      const have = readFileSync(to, "utf8");
      const lines = new Set(have.split(/\r?\n/).map((l) => l.trim()));
      const add = readFileSync(join(SKELETON_DIR, rel), "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#") && !lines.has(l.trim()));
      if (add.length) writeFileSync(to, `${have.replace(/\n*$/, "\n")}\n# doltap\n${add.join("\n")}\n`);
    } else cpSync(join(SKELETON_DIR, rel), to);
    copied.push(dest);
  }
  return copied;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    n += statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

function stampDates(dir: string, today: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) stampDates(p, today);
    else if (name.endsWith(".md")) {
      const s = readFileSync(p, "utf8");
      const out = s.replace(/^(created|updated): \d{4}-\d{2}-\d{2}$/gm, `$1: ${today}`);
      if (out !== s) writeFileSync(p, out);
    }
  }
}

/**
 * Create a new wiki repository at `dir`: protocol, templates, tags, category hubs, Obsidian config,
 * .gitignore/.gitattributes, then `git init` and one commit. Refuses to touch an existing wiki.
 */
export function scaffoldWiki(dirIn: string, opts: ScaffoldOptions = {}): ScaffoldResult {
  const dir = resolve(dirIn);
  if (existsSync(join(dir, "wiki"))) throw new Error(`${dir}/wiki already exists; refusing to overwrite`);
  if (!existsSync(SKELETON_DIR)) throw new Error(`skeleton not found at ${SKELETON_DIR} (broken install?)`);
  if (existsSync(dir) && readdirSync(dir).length && !opts.force) {
    throw new Error(`${dir} is not empty; pick an empty directory, or pass --force to set the wiki up next to the existing files (only the skeleton is committed)`);
  }
  mkdirSync(dir, { recursive: true });
  const copied = copySkeleton(dir);
  stampDates(join(dir, "wiki"), isoToday());
  const notes: string[] = [];

  if (!existsSync(join(dir, ".git"))) git(dir, ["init", "-q", "-b", "main"]);
  let identity = "";
  try { identity = git(dir, ["config", "user.email"]); } catch { /* unset */ }
  // Commit with a placeholder when no identity is configured, but do not persist it: the user (or agent)
  // should set the real name and email afterwards, and a later `git config user.email` check must still be empty.
  const idArgs = identity ? [] : ["-c", "user.name=doltap", "-c", "user.email=doltap@localhost"];
  if (!identity) notes.push("git identity is not configured; the initial commit is authored as doltap <doltap@localhost>. Set `git config user.name` and `user.email` in this repository before agents write pages");
  git(dir, ["add", "--", ...copied]);
  git(dir, [...idArgs, "commit", "-q", "-m", "wiki: initialize Doltap wiki\n\n[agent:doltap-init]", "--", ...copied]);

  let pushed: boolean | null = null;
  if (opts.remote) {
    git(dir, ["remote", "add", "origin", opts.remote]);
    try {
      git(dir, ["push", "-q", "-u", "origin", "main"]);
      pushed = true;
    } catch (e) {
      pushed = false;
      notes.push(`push to ${opts.remote} failed: ${(e as Error).message.split("\n")[0]}; run \`git push -u origin main\` in ${dir} once the remote exists`);
    }
  } else notes.push("no remote yet: create an empty private repository, then `git remote add origin <url> && git push -u origin main`");

  return { dir, files: countFiles(join(dir, "wiki")), pushed, notes };
}
