import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Category, Confidence, WikiConfig } from "./config.js";

export interface PageMeta {
  title: string;
  category: string;
  summary: string;
  tags: string[];
  confidence: Confidence | string;
  created: string;
  updated: string;
  sources: string[];
  [extra: string]: unknown;
}

export interface Section {
  heading: string;
  level: number;
  /** Body text under the heading, without the heading line. */
  content: string;
  /** Line index of the heading line in the body. */
  start: number;
  /** Exclusive end line index. */
  end: number;
}

export interface Page {
  id: string;
  /** Path relative to wikiDir, posix separators. */
  relPath: string;
  absPath: string;
  meta: PageMeta;
  body: string;
  sections: Section[];
  links: string[];
  raw: string;
  /** Content revision (sha1 of the normalized file, 12 hex chars). Pass it back as base_rev on a write to detect concurrent edits. */
  rev: string;
}

const LINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]+)?\]\]/g;

export function idFromRelPath(relPath: string): string {
  return toPosix(relPath).replace(/\.md$/, "");
}

/** One or more `/`-separated segments of `[A-Za-z0-9_-]`, no dots: an id can never name a path outside wiki/. */
export const PAGE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$/;
const PAGE_ID_MAX = 200;

/** Throw unless `id` is a safe page id. Every file access by id goes through this. */
export function assertPageId(id: string): string {
  if (typeof id !== "string" || id.length > PAGE_ID_MAX || !PAGE_ID_RE.test(id)) {
    throw new Error(`invalid page id: ${JSON.stringify(String(id).slice(0, 80))} (expected <category>/<kebab-slug>, letters, digits, - and _ only)`);
  }
  return id;
}

export function relPathFromId(id: string): string {
  return `${assertPageId(id)}.md`;
}

export function isPageId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*(\/[a-zA-Z0-9_][a-zA-Z0-9_-]*)+$/.test(id) || /^[A-Za-z][A-Za-z0-9-]*$/.test(id);
}

/** Remove fenced blocks and inline code so links inside examples are not treated as real links. */
export function stripCode(body: string): string {
  return body.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");
}

export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of stripCode(body).matchAll(LINK_RE)) out.add(m[1].trim());
  return [...out];
}

export function splitSections(body: string): Section[] {
  const lines = body.split("\n");
  const sections: Section[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    sections.push({ heading: m[2], level: m[1].length, content: "", start: i, end: lines.length });
  }
  // A section runs until the next heading at its own level or higher: `### Daily` under `## Steps` belongs to Steps.
  for (let i = 0; i < sections.length; i++) {
    const next = sections.slice(i + 1).find((s) => s.level <= sections[i].level);
    sections[i].end = next ? next.start : lines.length;
    sections[i].content = lines.slice(sections[i].start + 1, sections[i].end).join("\n").trim();
  }
  return sections;
}

/**
 * Find a section by heading (case-insensitive). A `##` section wins over a deeper heading with the same
 * text (`### Verification` inside Steps must not shadow `## Verification`). Two candidates at the chosen
 * level are an error rather than a silent first match.
 */
export function findSection(sections: Section[], heading: string): Section | undefined {
  const want = heading.trim().toLowerCase();
  const all = sections.filter((s) => s.heading.toLowerCase() === want);
  const level2 = all.filter((s) => s.level === 2);
  const pick = level2.length ? level2 : all;
  if (pick.length > 1) throw new Error(`section "${heading}" is ambiguous: ${pick.length} headings match (lines ${pick.map((s) => s.start + 1).join(", ")})`);
  return pick[0];
}

export interface ReplaceOptions {
  /** Append a new `## heading` when the section does not exist. Without it an unknown heading is an error. */
  create?: boolean;
}

/**
 * Replace (or append to) the content of one section. Only the section itself is rewritten: blank lines
 * elsewhere in the body (inside code blocks, between other sections) are left exactly as they were.
 * Leading indentation of the new content is preserved; only surrounding blank lines are trimmed.
 */
export function replaceSection(body: string, heading: string, content: string, mode: "replace" | "append" = "replace", o: ReplaceOptions = {}): string {
  const lines = body.split("\n");
  const sections = splitSections(body);
  const sec = findSection(sections, heading);
  const text = content.replace(/^\n+/, "").trimEnd();
  if (!sec) {
    if (!o.create) throw new Error(`section "${heading}" not found. Sections: ${sections.map((s) => s.heading).join(", ")} (pass create=true to add it)`);
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}\n\n## ${heading.trim()}\n\n${text}\n`;
  }
  const existing = lines.slice(sec.start + 1, sec.end).join("\n").replace(/^\n+/, "").trimEnd();
  const newContent = mode === "append" && existing ? `${existing}\n\n${text}` : text;
  const before = lines.slice(0, sec.start + 1);
  const after = lines.slice(sec.end);
  const rebuilt = [...before, "", newContent, "", ...after].join("\n");
  return rebuilt.replace(/\s+$/, "") + "\n";
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v == null || v === "") return [];
  return [String(v)];
}

function toDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v == null ? "" : String(v);
}

export function normalizeMeta(data: Record<string, unknown>): PageMeta {
  return {
    ...data,
    title: String(data.title ?? ""),
    category: String(data.category ?? ""),
    summary: String(data.summary ?? ""),
    tags: toStringArray(data.tags),
    confidence: String(data.confidence ?? ""),
    created: toDate(data.created),
    updated: toDate(data.updated),
    sources: toStringArray(data.sources),
  };
}

export function toPosix(p: string): string {
  return p.split(sep).join("/").replace(/\\/g, "/");
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Split `---` frontmatter from the body. Pages without frontmatter get empty data. The YAML is read with the
 * failsafe schema (everything is a string): `title: 1.10` stays "1.10" and `created: 2026-10-18` stays a
 * date string, so a patch never rewrites a value the author did not touch.
 */
export function splitFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { data: {}, content: raw };
  const parsed = parseYaml(m[1], { schema: "failsafe" }) as unknown;
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { data, content: raw.slice(m[0].length) };
}

export function parsePage(cfg: WikiConfig, relPath: string, rawInput: string): Page {
  const posix = toPosix(relPath);
  // Windows checkouts with autocrlf may hand us CRLF; the wiki is LF everywhere. Editors may add a BOM.
  const raw = rawInput.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let split: ReturnType<typeof splitFrontmatter>;
  try {
    split = splitFrontmatter(raw);
  } catch (e) {
    throw new Error(`invalid frontmatter in ${posix}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { data, content } = split;
  const meta = normalizeMeta(data as Record<string, unknown>);
  const body = content.replace(/^\n+/, "");
  return {
    id: idFromRelPath(posix),
    relPath: posix,
    absPath: join(cfg.wikiDir, relPath),
    meta,
    body,
    sections: splitSections(body),
    links: extractLinks(body),
    raw,
    rev: createHash("sha1").update(raw).digest("hex").slice(0, 12),
  };
}

export function readPage(cfg: WikiConfig, id: string): Page | null {
  const relPath = relPathFromId(id);
  const abs = join(cfg.wikiDir, relPath);
  if (!existsSync(abs)) return null;
  // A symlinked page file would read whatever it points at (another wiki, .doltap/http-token, /etc/...).
  // Pages are regular files only; lint reports symlinks so the owner can remove them.
  if (lstatSync(abs).isSymbolicLink()) return null;
  return parsePage(cfg, relPath, readFileSync(abs, "utf8"));
}

export function serializePage(meta: PageMeta, body: string): string {
  // Fixed key order keeps diffs stable across machines.
  const order = ["title", "category", "summary", "tags", "confidence", "created", "updated", "sources"];
  const ordered: Record<string, unknown> = {};
  for (const k of order) ordered[k] = meta[k];
  for (const k of Object.keys(meta)) if (!(k in ordered)) ordered[k] = meta[k];
  const yaml = stringifyYaml(ordered, { lineWidth: 0 }).replace(/\s+$/, "");
  return `---\n${yaml}\n---\n\n${body.replace(/\s+$/, "")}\n`;
}

export function categoryOf(id: string): Category | string {
  return id.split("/")[0];
}

export function pageRelPaths(cfg: WikiConfig, files: string[]): string[] {
  return files.map((f) => relative(cfg.wikiDir, f));
}
