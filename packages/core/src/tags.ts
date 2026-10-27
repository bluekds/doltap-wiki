import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { WikiConfig } from "./config.js";
import { commitAndPush, commitMessage, emptyReport, pull, assertOnBranch, type SyncReport } from "./git.js";
import { withWriteLock } from "./lock.js";

export interface TagInfo {
  tag: string;
  group: string;
  description: string;
}

export function tagsPath(cfg: WikiConfig): string {
  return join(cfg.wikiDir, "_meta", "tags.yaml");
}

export function loadTags(cfg: WikiConfig): TagInfo[] {
  return parseTags(readFileSync(tagsPath(cfg), "utf8"));
}

/**
 * Parse tags.yaml text. Duplicate keys are tolerated (last one wins): `merge=union` keeps both lines when two
 * machines add the same tag at once, and a vocabulary that fails to parse would block every write on every clone.
 */
export function parseTags(raw: string): TagInfo[] {
  const doc = parse(raw, { uniqueKeys: false }) as Record<string, Record<string, unknown>> | null;
  const seen = new Map<string, TagInfo>();
  for (const [group, tags] of Object.entries(doc ?? {})) {
    if (!tags || typeof tags !== "object") continue;
    for (const [tag, description] of Object.entries(tags)) seen.set(tag, { tag, group, description: description == null ? "" : String(description) });
  }
  return [...seen.values()];
}

export function allowedTagSet(cfg: WikiConfig): Set<string> {
  return new Set(loadTags(cfg).map((t) => t.tag));
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Closest allowed tags to a misspelled one (edit distance <= 2, or a prefix/substring), best first. */
export function suggestTags(unknown: string, allowed: Iterable<string>, max = 3): string[] {
  const u = unknown.toLowerCase();
  return [...allowed]
    .map((t) => ({ t, d: t.includes(u) || u.includes(t) ? 1 : editDistance(u, t) }))
    .filter((x) => x.d <= 2)
    .sort((a, b) => a.d - b.d || a.t.localeCompare(b.t))
    .slice(0, max)
    .map((x) => x.t);
}

export interface AddTagInput {
  tag: string;
  description: string;
  /** Group heading in tags.yaml; created at the end of the file when missing. Default "other". */
  group?: string;
}

export interface TagWriteResult {
  tag: string;
  group: string;
  sync: SyncReport;
  refused?: string;
}

const TAG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Append a tag to its group in `_meta/tags.yaml`, editing the text so comments and ordering survive, then
 * commit and push. The vocabulary is shared, so this is the only way MCP-only agents can introduce a tag.
 */
export function addTag(cfg: WikiConfig, input: AddTagInput): TagWriteResult {
  const tag = input.tag.trim();
  const group = (input.group ?? "other").trim();
  const description = input.description.replace(/\s+/g, " ").trim();
  if (!TAG_RE.test(tag)) throw new Error(`tag "${tag}" must be kebab-case (letters, digits, hyphens)`);
  if (!TAG_RE.test(group)) throw new Error(`group "${group}" must be kebab-case`);
  if (!description) throw new Error("a one-line description is required");
  return withWriteLock(cfg, () => {
    assertOnBranch(cfg);
    const sync = emptyReport();
    pull(cfg, sync);
    if (allowedTagSet(cfg).has(tag)) throw new Error(`tag "${tag}" already exists`);
    const path = tagsPath(cfg);
    const before = parseTags(readFileSync(path, "utf8"));
    const lines = dedupeLines(readFileSync(path, "utf8").replace(/\s+$/, "").split("\n"));
    // Let the YAML library quote the value: a description starting with ` @ [ ' " * | > % & ! { would otherwise change meaning or break the file.
    const entry = "  " + stringify({ [tag]: description }).trimEnd();
    const headRe = new RegExp(`^${group}:\\s*(#.*)?$`);
    const head = lines.findIndex((l) => headRe.test(l));
    if (head >= 0) {
      let end = head + 1;
      while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
      lines.splice(end, 0, entry);
    } else lines.push("", `${group}:`, entry);
    const next = lines.join("\n") + "\n";
    verifyEdit(next, before, [...before.map((t) => t.tag), tag]);
    writeFileSync(path, next);
    commitAndPush(cfg, [join("wiki", "_meta", "tags.yaml")], commitMessage(cfg, "add tag", tag), sync);
    return { tag, group, sync };
  });
}

/** Drop the second copy of a duplicated `  tag:` line (what a union merge leaves behind); the later line is kept, like the parser does. */
function dedupeLines(lines: string[]): string[] {
  const last = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = /^\s+([a-z0-9-]+):/.exec(l);
    if (m) last.set(m[1], i);
  });
  return lines.filter((l, i) => {
    const m = /^\s+([a-z0-9-]+):/.exec(l);
    return !m || last.get(m[1]) === i;
  });
}

/** Refuse to write a vocabulary that no longer parses or lost a tag: every clone loads this file on every write. */
function verifyEdit(next: string, before: TagInfo[], expectTags: string[]): void {
  let after: TagInfo[];
  try {
    after = parseTags(next);
  } catch (e) {
    throw new Error(`refusing to write tags.yaml: the result does not parse (${e instanceof Error ? e.message : String(e)})`);
  }
  const have = new Set(after.map((t) => t.tag));
  const missing = expectTags.filter((t) => !have.has(t));
  if (missing.length) throw new Error(`refusing to write tags.yaml: ${missing.join(", ")} would be lost`);
  for (const t of before) {
    const n = after.find((x) => x.tag === t.tag);
    if (n && n.description !== t.description && expectTags.includes(t.tag)) throw new Error(`refusing to write tags.yaml: description of ${t.tag} would change`);
  }
}

/** Remove a tag that no page uses. */
export function removeTag(cfg: WikiConfig, tag: string, usedBy: string[]): TagWriteResult {
  if (usedBy.length) throw new Error(`tag "${tag}" is used by ${usedBy.length} page(s): ${usedBy.slice(0, 5).join(", ")}${usedBy.length > 5 ? ", …" : ""}`);
  return withWriteLock(cfg, () => {
    assertOnBranch(cfg);
    const sync = emptyReport();
    pull(cfg, sync);
    const info = loadTags(cfg).find((t) => t.tag === tag);
    if (!info) throw new Error(`tag "${tag}" is not in tags.yaml`);
    const path = tagsPath(cfg);
    const before = parseTags(readFileSync(path, "utf8"));
    const re = new RegExp(`^\\s+${tag}:`);
    const lines = readFileSync(path, "utf8").replace(/\s+$/, "").split("\n").filter((l) => !re.test(l));
    const next = lines.join("\n") + "\n";
    if (parseTags(next).some((t) => t.tag === tag)) throw new Error(`could not remove "${tag}" from tags.yaml; edit the file by hand`);
    verifyEdit(next, before, before.map((t) => t.tag).filter((t) => t !== tag));
    writeFileSync(path, next);
    commitAndPush(cfg, [join("wiki", "_meta", "tags.yaml")], commitMessage(cfg, "remove tag", tag), sync);
    return { tag, group: info.group, sync };
  });
}
