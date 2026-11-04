import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { safePath } from "./safe.js";
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
  /** Date after which a volatile page (howto, reference) should be re-checked against its sources. Unset = no deadline. */
  review_by?: string;
  verified_on?: string;
  verified_by?: string;
  replaced_by?: string;
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

// No class admits `[`, so a run of `[[[[` is scanned once, not once per start position (audit S4).
const LINK_RE = /\[\[([^\]|#[]+)(?:#([^\]|[]+))?(?:\|[^\][]+)?\]\]/g;

/** Pages larger than this are refused by the parser (and so by the index and every write). */
export const PAGE_MAX_CHARS = 1_000_000;

/**
 * Fence state per line: true for lines inside a fenced code block (the fence lines included). A fence opens
 * with three or more backticks or tildes after up to three spaces and closes only with the same character,
 * at least as long. Linear in the body size; no regex spans lines.
 */
export function fencedLines(lines: string[]): boolean[] {
  const out = new Array<boolean>(lines.length).fill(false);
  let open: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    // Any indentation: a fence inside a list item sits four or more spaces in and is still a fence to the reader.
    const m = /^[ \t]*(`{3,}|~{3,})/.exec(lines[i]);
    if (open) {
      out[i] = true;
      if (m && m[1][0] === open.ch && m[1].length >= open.len) open = null;
    } else if (m) {
      out[i] = true;
      open = { ch: m[1][0], len: m[1].length };
    }
  }
  return out;
}

/** Parse one line as an ATX heading: level and text, with a closing hash sequence (preceded by a space) removed. */
export function parseHeading(line: string): { level: number; heading: string } | null {
  const m = /^(#{1,6})[ \t]+(.*)$/.exec(line);
  if (!m) return null;
  let text = m[2].trimEnd();
  const close = /(?:^|[ \t])#+$/.exec(text);
  if (close) text = text.slice(0, close.index).trimEnd();
  if (!text) return null;
  return { level: m[1].length, heading: text };
}

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
  const lines = body.split("\n");
  const fenced = fencedLines(lines);
  return lines.filter((_, i) => !fenced[i]).join("\n").replace(/`[^`\n]*`/g, "");
}

export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of stripCode(body).matchAll(LINK_RE)) out.add(m[1].trim());
  return [...out];
}

export function splitSections(body: string): Section[] {
  const lines = body.split("\n");
  const sections: Section[] = [];
  const fenced = fencedLines(lines);
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const h = parseHeading(lines[i]);
    if (!h) continue;
    sections.push({ heading: h.heading, level: h.level, content: "", start: i, end: lines.length });
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
  // Content that carries a heading at the section's level (or above) would create a second section, and a
  // duplicate name makes every later edit of that section ambiguous (a hub with two "Manual list" sections
  // used to break every write). Sub-headings below the section's level are fine.
  const level = sec?.level ?? 2;
  const contentLines = text.split("\n");
  const fenced = fencedLines(contentLines);
  for (let i = 0; i < contentLines.length; i++) {
    if (fenced[i]) continue;
    const h = parseHeading(contentLines[i]);
    if (h && h.level <= level) throw new Error(`content contains a level-${h.level} heading "${h.heading}"; a heading at the section's level or above belongs in its own section (use ${"#".repeat(level + 1)} for a sub-heading)`);
  }
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

/** Remove whole sections (heading line through the end of their content) from a body. */
export function dropSections(body: string, secs: Section[]): string {
  const lines = body.split("\n");
  for (const s of [...secs].sort((a, b) => b.start - a.start)) lines.splice(s.start, s.end - s.start);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
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

/** `key: null` and `key: ~` read as the strings "null" / "~" under the failsafe schema; for an optional field they mean absent (audit I2). */
const isNullish = (v: unknown): boolean => v == null || v === "" || v === "null" || v === "~";

export function normalizeMeta(data: Record<string, unknown>): PageMeta {
  const { review_by: _rb, verified_on: _vo, ...rest } = data;
  for (const key of ["replaced_by", "verified_by"]) if (key in rest && isNullish(rest[key])) delete rest[key];
  return {
    ...rest,
    title: String(data.title ?? ""),
    category: String(data.category ?? ""),
    summary: String(data.summary ?? ""),
    tags: toStringArray(data.tags),
    confidence: String(data.confidence ?? ""),
    created: toDate(data.created),
    updated: toDate(data.updated),
    sources: toStringArray(data.sources),
    ...optionalDate("review_by", data.review_by),
    ...optionalDate("verified_on", data.verified_on),
  };
}

/** Lifecycle dates are optional: an empty placeholder (`review_by:` from a template) is the same as absent. */
function optionalDate(key: string, v: unknown): Record<string, string> {
  const s = isNullish(v) ? "" : toDate(v).trim();
  return s ? { [key]: s } : {};
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
  if (rawInput.length > PAGE_MAX_CHARS) throw new Error(`${posix} is too large (${rawInput.length} chars, cap ${PAGE_MAX_CHARS}); split it or attach the bulk under wiki/_assets`);
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
  // A symlinked page file or directory would read whatever it points at (another wiki, .doltap/http-token, /etc/...).
  // Pages are regular files under regular directories; lint reports symlinks so the owner can remove them.
  let abs: string;
  try { abs = safePath(cfg.root, join(cfg.wikiDir, relPath)); } catch { return null; }
  if (!existsSync(abs)) return null;
  return parsePage(cfg, relPath, readFileSync(abs, "utf8"));
}

export function serializePage(meta: PageMeta, body: string): string {
  // Fixed key order keeps diffs stable across machines.
  const order = ["title", "category", "summary", "tags", "confidence", "created", "updated", "sources"];
  const ordered: Record<string, unknown> = {};
  for (const k of order) ordered[k] = meta[k];
  for (const k of Object.keys(meta)) if (!(k in ordered)) ordered[k] = meta[k];
  for (const k of Object.keys(ordered)) if (ordered[k] === undefined || ordered[k] === null) delete ordered[k];
  const yaml = stringifyYaml(ordered, { lineWidth: 0 }).replace(/\s+$/, "");
  return `---\n${yaml}\n---\n\n${body.replace(/\s+$/, "")}\n`;
}

export function categoryOf(id: string): Category | string {
  return id.split("/")[0];
}

export function pageRelPaths(cfg: WikiConfig, files: string[]): string[] {
  return files.map((f) => relative(cfg.wikiDir, f));
}
