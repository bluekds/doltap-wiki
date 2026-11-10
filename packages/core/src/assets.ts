import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { safePath } from "./safe.js";
import { stripCode } from "./page.js";
import { findSecrets } from "./secrets.js";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { WikiConfig } from "./config.js";
import { WikiDb } from "./db.js";
import { commitAndPush, commitMessage, type SyncReport } from "./git.js";
import { withWriteLock } from "./lock.js";
import { isWindowsReservedName, readPage } from "./page.js";

/**
 * Attachments: files a page needs (a diagram, a sample config, an exported table) live in
 * wiki/_assets/<page id>/<file> and the page links them with a relative markdown link. They are not
 * pages: the index, search and the page walker skip _assets. Lint checks the links, the size cap, the
 * file type, orphans, and scans text attachments for secrets like a page.
 */
export const ASSET_MAX_BYTES = 2 * 1024 * 1024;
export const ASSET_TYPES: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "txt", "csv", "json", "yaml", "yml", "md", "log"]);
/** Attachments whose content is text and can be scanned for credentials. */
export const ASSET_TEXT_TYPES: ReadonlySet<string> = new Set(["svg", "txt", "csv", "json", "yaml", "yml", "md", "log"]);

const toPosix = (p: string) => p.split(sep).join("/");

export function assetsDir(cfg: WikiConfig): string {
  return join(cfg.wikiDir, "_assets");
}

export function assetExt(file: string): string {
  return extname(file).slice(1).toLowerCase();
}

/** The link target a page uses for its own attachment: relative to the page's directory. */
export function assetLinkFor(id: string, file: string): string {
  return `${"../".repeat(id.split("/").length - 1)}_assets/${id}/${file}`;
}

export interface AssetRef {
  /** The link target as written in the page. */
  target: string;
  /** Path relative to wiki/_assets, forward slashes. */
  rel: string;
  /** Absolute path on disk (may not exist). */
  abs: string;
}

// `[` is excluded from the label class so a run of `[[[` or `![![` is scanned once (audit S4).
const MD_LINK_RE = /!?\[[^\][]*\]\(([^()\s[\]]+)(?:\s+"[^"]*")?\)/g;

/** Markdown links may percent-encode a name (`my%20shot.png`); the file on disk has the plain name. */
function decodeTarget(t: string): string {
  try { return decodeURIComponent(t); } catch { return t; }
}

/** Markdown links in `raw` that point under wiki/_assets, resolved from the page's own directory (or from wiki/ when they start with "/"). */
export function assetRefsIn(raw: string, pageAbsPath: string, wikiDir: string): AssetRef[] {
  const out: AssetRef[] = [];
  const base = resolve(assetsDir({ wikiDir } as WikiConfig));
  for (const m of stripCode(raw).matchAll(MD_LINK_RE)) { // a link inside a code example is not an attachment
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || !target.includes("_assets/")) continue;
    const clean = decodeTarget(target.replace(/[?#].*$/, ""));
    const abs = resolve(clean.startsWith("/") ? join(wikiDir, clean) : join(dirname(pageAbsPath), clean));
    const rel = relative(base, abs);
    if (!rel || rel.startsWith("..") || resolve(abs) !== abs) continue;
    out.push({ target, rel: toPosix(rel), abs });
  }
  return out;
}

/** Every file under wiki/_assets as a path relative to it (forward slashes), sorted. Symlinks are skipped. */
export function walkAssets(cfg: WikiConfig): string[] {
  const root = assetsDir(cfg);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      const p = join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) walk(p);
      else out.push(toPosix(relative(root, p)));
    }
  };
  walk(root);
  return out.sort();
}

export interface AssetInfo {
  path: string;
  bytes: number;
  ext: string;
  referencedBy: string[];
}

/** Every attachment with its size and the pages that link it. */
export function listAssets(cfg: WikiConfig): AssetInfo[] {
  const refs = new Map<string, Set<string>>();
  const db = new WikiDb(cfg);
  try {
    const { pages } = db.reindex(false, { pages: true });
    for (const p of pages) for (const r of assetRefsIn(p.raw, join(cfg.wikiDir, p.relPath), cfg.wikiDir)) {
      if (!refs.has(r.rel)) refs.set(r.rel, new Set());
      refs.get(r.rel)!.add(p.id);
    }
  } finally {
    db.close();
  }
  return walkAssets(cfg).map((path) => ({ path, bytes: statSync(join(assetsDir(cfg), path)).size, ext: assetExt(path), referencedBy: [...(refs.get(path) ?? [])].sort() }));
}

export interface AddAssetInput {
  /** The page the file belongs to. */
  id: string;
  /** Source file on disk; copied, never moved. */
  file: string;
  /** Allow a file over ASSET_MAX_BYTES or of an unlisted type. */
  force?: boolean;
}

export interface AddAssetResult {
  /** Path relative to wiki/_assets. */
  path: string;
  /** The markdown link to paste into the page (an image embed for image types). */
  link: string;
  bytes: number;
  sync: SyncReport;
}

/** Copy a file into wiki/_assets/<id>/ and commit it. The page itself is not edited; paste the returned link where it belongs. */
export function addAsset(cfg: WikiConfig, i: AddAssetInput): AddAssetResult {
  if (!readPage(cfg, i.id)) throw new Error(`no page ${i.id}; create the page first, then attach files to it`);
  if (!existsSync(i.file) || !statSync(i.file).isFile()) throw new Error(`${i.file} is not a file`);
  const name = basename(i.file);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`attachment name "${name}" must be letters, digits, dot, dash or underscore`);
  if (isWindowsReservedName(name)) throw new Error(`attachment name "${name}" is reserved on Windows (a device name or a trailing dot), so a Windows clone could not check it out; rename the file`);
  const bytes = statSync(i.file).size;
  const ext = assetExt(name);
  if (ASSET_TEXT_TYPES.has(ext)) {
    // Attachments are shared through git like pages; the filter that refuses a token in a page refuses it here too (no --force).
    const found = findSecrets(readFileSync(i.file, "utf8"));
    if (found.length) throw new Error(`${name} contains a possible secret (${found.join(", ")}); record where the secret lives instead of attaching it`);
  }
  if (!i.force) {
    if (bytes > ASSET_MAX_BYTES) throw new Error(`${name} is ${bytes} bytes, larger than the ${ASSET_MAX_BYTES} byte cap; shrink it or pass --force`);
    if (!ASSET_TYPES.has(ext)) throw new Error(`.${ext || "(none)"} is not an attachment type (${[...ASSET_TYPES].join(", ")}); pass --force to add it anyway`);
  }
  return withWriteLock(cfg, () => {
    const dir = join(assetsDir(cfg), ...i.id.split("/"));
    const dest = safePath(cfg.root, join(dir, name));
    if (existsSync(dest)) throw new Error(`${toPosix(relative(cfg.root, dest))} already exists; remove it first or rename the file`);
    mkdirSync(dir, { recursive: true });
    copyFileSync(i.file, dest);
    const sync = commitAndPush(cfg, [join("wiki", "_assets", ...i.id.split("/"), name)], commitMessage(cfg, "asset", `${i.id} ${name}`));
    const image = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);
    const label = image ? name.replace(/\.[^.]+$/, "") : name;
    return { path: `${i.id}/${name}`, link: `${image ? "!" : ""}[${label}](${assetLinkFor(i.id, name)})`, bytes, sync };
  });
}
