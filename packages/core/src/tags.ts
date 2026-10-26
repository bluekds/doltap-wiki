import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { WikiConfig } from "./config.js";
import { commitAndPush, emptyReport, pull, assertOnBranch, type SyncReport } from "./git.js";
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
  const raw = readFileSync(tagsPath(cfg), "utf8");
  const doc = parse(raw) as Record<string, Record<string, string>>;
  const out: TagInfo[] = [];
  for (const [group, tags] of Object.entries(doc ?? {})) {
    for (const [tag, description] of Object.entries(tags ?? {})) out.push({ tag, group, description: String(description) });
  }
  return out;
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
  if (/[:#]/.test(description)) throw new Error("description must not contain ':' or '#'");
  return withWriteLock(cfg, () => {
    assertOnBranch(cfg);
    const sync = emptyReport();
    pull(cfg, sync);
    if (allowedTagSet(cfg).has(tag)) throw new Error(`tag "${tag}" already exists`);
    const path = tagsPath(cfg);
    const lines = readFileSync(path, "utf8").replace(/\s+$/, "").split("\n");
    const entry = `  ${tag}: ${description}`;
    const head = lines.findIndex((l) => l === `${group}:`);
    if (head >= 0) {
      let end = head + 1;
      while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
      lines.splice(end, 0, entry);
    } else lines.push("", `${group}:`, entry);
    writeFileSync(path, lines.join("\n") + "\n");
    commitAndPush(cfg, [join("wiki", "_meta", "tags.yaml")], `wiki: add tag ${tag}\n\n[host:${cfg.hostname}] [agent:${cfg.agent}]${cfg.session ? ` [session:${cfg.session}]` : ""}`, sync);
    return { tag, group, sync };
  });
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
    const lines = readFileSync(path, "utf8").replace(/\s+$/, "").split("\n");
    const i = lines.findIndex((l) => new RegExp(`^  ${tag}:`).test(l));
    if (i >= 0) lines.splice(i, 1);
    writeFileSync(path, lines.join("\n") + "\n");
    commitAndPush(cfg, [join("wiki", "_meta", "tags.yaml")], `wiki: remove tag ${tag}\n\n[host:${cfg.hostname}] [agent:${cfg.agent}]`, sync);
    return { tag, group: info.group, sync };
  });
}
