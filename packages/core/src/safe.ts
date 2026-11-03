import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Path boundary for everything doltap reads or writes under a wiki root. A clone receives whatever a
 * collaborator pushed, and git checks out a committed symlink as a symlink, so a path under the root
 * can point at any file on this machine (another wiki, .doltap/http-token, ~/.zshrc). Every component
 * below the root is lstat'ed; a symlink anywhere refuses the operation. The root itself may be a
 * symlink (~/.doltap usually is), so it is taken as given.
 */
export function safePath(root: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(resolve(root), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${p} is outside the wiki root`);
  let cur = resolve(root);
  for (const seg of rel.split(sep)) {
    cur = join(cur, seg);
    let st;
    try { st = lstatSync(cur); } catch { return abs; } // nothing exists from here on: a new file or directory
    if (st.isSymbolicLink()) throw new Error(`${toPosixRel(root, cur)} is a symbolic link; doltap does not follow links inside the wiki (remove it)`);
  }
  return abs;
}

const toPosixRel = (root: string, abs: string) => relative(resolve(root), abs).split(sep).join("/");

export function readSafe(root: string, p: string): string {
  return readFileSync(safePath(root, p), "utf8");
}

export interface WriteSafeOptions {
  /** Replace a symlink at the target with a regular file instead of refusing (generated, gitignored files only). */
  replaceSymlink?: boolean;
}

export function writeSafe(root: string, p: string, data: string | Buffer, o: WriteSafeOptions = {}): string {
  let abs: string;
  try {
    abs = safePath(root, p);
  } catch (e) {
    if (!o.replaceSymlink) throw e;
    // Only the final component may be replaced; a symlinked parent still refuses.
    const parentOk = safePath(root, join(p, ".."));
    abs = join(parentOk, p.split(/[\\/]/).pop()!);
    unlinkSync(abs);
  }
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}

/** Every symlink under the root (files or directories, any depth), as posix paths relative to the root. `.git` is not entered. */
export function listSymlinks(root: string, skip: string[] = [".git", "node_modules"]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (skip.includes(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isSymbolicLink()) out.push(toPosixRel(root, p));
      else if (ent.isDirectory()) walk(p);
    }
  };
  walk(resolve(root));
  return out.sort();
}
