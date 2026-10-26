import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readFileSync, existsSync } from "node:fs";
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
    if (sections.length) sections[sections.length - 1].end = i;
    sections.push({ heading: m[2], level: m[1].length, content: "", start: i, end: lines.length });
  }
  for (const s of sections) s.content = lines.slice(s.start + 1, s.end).join("\n").trim();
  return sections;
}

export function findSection(sections: Section[], heading: string): Section | undefined {
  const want = heading.trim().toLowerCase();
  return sections.find((s) => s.heading.toLowerCase() === want);
}

/**
 * Replace (or append to) the content of a `## heading` section. If the section does not exist it is
 * appended at the end of the body with level 2.
 */
export function replaceSection(body: string, heading: string, content: string, mode: "replace" | "append" = "replace"): string {
  const lines = body.split("\n");
  const sections = splitSections(body);
  const sec = findSection(sections, heading);
  const text = content.trim();
  if (!sec) {
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}\n\n## ${heading.trim()}\n\n${text}\n`;
  }
  const newContent = mode === "append" && sec.content ? `${sec.content}\n\n${text}` : text;
  const before = lines.slice(0, sec.start + 1);
  const after = lines.slice(sec.end);
  const rebuilt = [...before, "", newContent, "", ...after].join("\n");
  return rebuilt.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
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

/** Split `---` frontmatter from the body. Pages without frontmatter get empty data. */
export function splitFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { data: {}, content: raw };
  const parsed = parseYaml(m[1]) as unknown;
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { data, content: raw.slice(m[0].length) };
}

export function parsePage(cfg: WikiConfig, relPath: string, rawInput: string): Page {
  const posix = toPosix(relPath);
  // Windows checkouts with autocrlf may hand us CRLF; the wiki is LF everywhere.
  const raw = rawInput.replace(/\r\n?/g, "\n");
  const { data, content } = splitFrontmatter(raw);
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
  };
}

export function readPage(cfg: WikiConfig, id: string): Page | null {
  const relPath = relPathFromId(id);
  const abs = join(cfg.wikiDir, relPath);
  if (!existsSync(abs)) return null;
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
