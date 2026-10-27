import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { WikiConfig } from "./config.js";
import { commitAndPush, commitMessage, emptyReport, git, isRepo, type SyncReport } from "./git.js";
import { withWriteLock } from "./lock.js";

const SKELETON_DIR = fileURLToPath(new URL("../skeleton/", import.meta.url));

/**
 * merge: line-set files; missing lines are appended, nothing is removed (.gitignore, .gitattributes).
 * replace: tool-owned files, overwritten on apply (Obsidian config, page templates).
 * review: shipped text the wiki usually customises; the diff is shown, never applied (PROTOCOL, shipped pages).
 * page: content pages shipped as examples; reported when missing, never written.
 */
export type UpgradeClass = "merge" | "replace" | "review" | "page";

export interface UpgradeItem {
  /** Path relative to the wiki root, forward slashes, real dot names. */
  path: string;
  class: UpgradeClass;
  status: "same" | "differs" | "missing";
  /** Unified diff (skeleton vs wiki) for differing files, when requested. */
  diff?: string;
  /** Lines the merge would add. */
  addLines?: string[];
}

export interface UpgradePlan {
  skeletonVersion: string;
  items: UpgradeItem[];
  /** Items `apply` would change: merge/replace files that differ or are missing. */
  applicable: UpgradeItem[];
  /** Items needing a human: review files that differ. */
  review: UpgradeItem[];
}

export interface UpgradeResult {
  applied: string[];
  skipped: string[];
  sync: SyncReport;
}

function classify(path: string): UpgradeClass {
  if (path === ".gitignore" || path === ".gitattributes") return "merge";
  if (path.startsWith("wiki/.obsidian/") || path.startsWith("wiki/_meta/templates/")) return "replace";
  if (path === "wiki/_meta/PROTOCOL.md" || path === "wiki/_meta/tags.yaml") return "review";
  return "page";
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** `dot.x` -> `.x` in each segment, forward slashes. */
function wikiPathOf(skelPath: string): string {
  return relative(SKELETON_DIR, skelPath).split(sep).map((seg) => (seg.startsWith("dot.") ? `.${seg.slice(4)}` : seg)).join("/");
}

const DATE_LINE = /^((?:created|updated): )(?:\{\{date\}\}|\d{4}-\d{2}-\d{2})$/gm;

/** Make the skeleton text comparable: take the wiki file's own created/updated dates so only real changes show. */
function normalizeSkeleton(skel: string, wiki: string | null): string {
  if (!wiki) return skel;
  const dates: Record<string, string> = {};
  for (const m of wiki.matchAll(/^(created|updated): (\d{4}-\d{2}-\d{2})$/gm)) dates[m[1]] = m[2];
  return skel.replace(DATE_LINE, (_, key: string) => `${key}${dates[key.slice(0, -2)] ?? "{{date}}"}`);
}

function lines(s: string): string[] {
  return s.split(/\r?\n/).filter((l) => l.trim() !== "");
}

function unifiedDiff(cfg: WikiConfig, label: string, skelText: string, wikiPath: string): string {
  const tmpDir = join(cfg.stateDir, "upgrade-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, label.replace(/[\\/]/g, "__"));
  writeFileSync(tmp, skelText);
  try {
    const res = git(cfg, ["diff", "--no-index", "--no-color", `--src-prefix=skeleton/`, `--dst-prefix=wiki/`, "--", tmp, wikiPath], { allowFail: true });
    return (res.stdout || res.stderr).replace(new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), label);
  } finally { rmSync(tmpDir, { recursive: true, force: true }); }
}

/** Compare the shipped skeleton with this wiki. Read-only. */
export function planUpgrade(cfg: WikiConfig, o: { diff?: boolean } = {}): UpgradePlan {
  if (!existsSync(SKELETON_DIR)) throw new Error(`skeleton not found at ${SKELETON_DIR} (broken install?)`);
  const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const items: UpgradeItem[] = [];
  for (const skelPath of walk(SKELETON_DIR).sort()) {
    const path = wikiPathOf(skelPath);
    const cls = classify(path);
    const target = join(cfg.root, ...path.split("/"));
    const skelRaw = readFileSync(skelPath, "utf8");
    if (!existsSync(target)) { items.push({ path, class: cls, status: "missing" }); continue; }
    const wikiRaw = readFileSync(target, "utf8");
    if (cls === "merge") {
      const have = new Set(lines(wikiRaw));
      const add = lines(skelRaw).filter((l) => !have.has(l));
      items.push({ path, class: cls, status: add.length ? "differs" : "same", addLines: add.length ? add : undefined });
      continue;
    }
    const skel = normalizeSkeleton(skelRaw, wikiRaw);
    const same = skel.replace(/\r\n/g, "\n") === wikiRaw.replace(/\r\n/g, "\n");
    const item: UpgradeItem = { path, class: cls, status: same ? "same" : "differs" };
    if (!same && o.diff && cls !== "page") item.diff = unifiedDiff(cfg, path, skel, target);
    items.push(item);
  }
  return {
    skeletonVersion: version,
    items,
    applicable: items.filter((i) => i.status !== "same" && (i.class === "merge" || i.class === "replace")),
    review: items.filter((i) => i.status === "differs" && i.class === "review"),
  };
}

/** Apply the merge and replace items of a plan, then commit them as one `upgrade` commit. */
export function applyUpgrade(cfg: WikiConfig, plan: UpgradePlan = planUpgrade(cfg)): UpgradeResult {
  return withWriteLock(cfg, () => {
    const applied: string[] = [];
    const skipped = plan.review.map((i) => i.path);
    for (const item of plan.applicable) {
      const target = join(cfg.root, ...item.path.split("/"));
      const skelPath = join(SKELETON_DIR, ...item.path.split("/").map((seg) => (seg.startsWith(".") ? `dot.${seg.slice(1)}` : seg)));
      mkdirSync(dirname(target), { recursive: true });
      if (item.class === "merge") {
        const current = existsSync(target) ? readFileSync(target, "utf8") : "";
        const add = item.addLines ?? lines(readFileSync(skelPath, "utf8"));
        writeFileSync(target, `${current.replace(/\s+$/, "")}${current.trim() ? "\n" : ""}${add.join("\n")}\n`);
      } else {
        const wikiRaw = existsSync(target) ? readFileSync(target, "utf8") : null;
        writeFileSync(target, normalizeSkeleton(readFileSync(skelPath, "utf8"), wikiRaw));
      }
      applied.push(item.path);
    }
    const sync = emptyReport();
    if (applied.length && isRepo(cfg)) commitAndPush(cfg, applied, commitMessage(cfg, "upgrade skeleton to", plan.skeletonVersion, `files: ${applied.join(", ")}`), sync);
    return { applied, skipped, sync };
  });
}
