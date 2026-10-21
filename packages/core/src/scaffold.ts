import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Files shipped with @doltap/core; `dot.<name>` entries become `.<name>` on copy so npm packs them. */
const SKELETON_DIR = fileURLToPath(new URL("../skeleton/", import.meta.url));

export interface ScaffoldOptions {
  /** git remote to add as origin and push to (optional) */
  remote?: string;
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

/** Rename `dot.x` -> `.x` recursively (skeleton files are stored without leading dots). */
function undot(dir: string): void {
  for (const name of readdirSync(dir)) {
    const from = join(dir, name);
    const to = name.startsWith("dot.") ? join(dir, name.slice(3)) : from;
    if (to !== from) renameSync(from, to);
    if (statSync(to).isDirectory()) undot(to);
  }
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
  mkdirSync(dir, { recursive: true });
  cpSync(SKELETON_DIR, dir, { recursive: true });
  undot(dir);
  stampDates(join(dir, "wiki"), isoToday());
  const notes: string[] = [];

  if (!existsSync(join(dir, ".git"))) git(dir, ["init", "-q", "-b", "main"]);
  let identity = "";
  try { identity = git(dir, ["config", "user.email"]); } catch { /* unset */ }
  if (!identity) {
    git(dir, ["config", "user.name", "doltap"]);
    git(dir, ["config", "user.email", "doltap@localhost"]);
    notes.push("git identity was not configured; set repo-local user.name=doltap user.email=doltap@localhost (change with `git config user.name/user.email`)");
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "wiki: initialize Doltap wiki\n\n[agent:doltap-init]"]);

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
