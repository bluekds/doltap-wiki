import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ASSET_MAX_BYTES, ASSET_TEXT_TYPES, ASSET_TYPES, assetExt, assetRefsIn, assetsDir, walkAssets } from "./assets.js";
import { CATEGORIES, CONFIDENCE, isCategoryHub, isProjectOverview, today, type WikiConfig } from "./config.js";
import type { Page } from "./page.js";
import { requiredSections } from "./template.js";
import { allowedTagSet, suggestTags } from "./tags.js";

export interface LintIssue {
  id: string;
  level: "error" | "warning";
  rule: string;
  message: string;
}

export interface LintContext {
  allowedTags: Set<string>;
  allIds: Set<string>;
  /** Ids whose confidence is deprecated (a replacement chain must not end on one). */
  deprecatedIds: Set<string>;
  /** id -> number of inbound links (from the index). */
  inbound: Map<string, number>;
  /** Where wiki/ is, to resolve attachment links. */
  wikiDir: string;
  requiredSections: Map<string, string[]>;
}

export function buildLintContext(cfg: WikiConfig, allIds: Set<string>, inbound: Map<string, number>, deprecatedIds: Set<string> = new Set()): LintContext {
  const req = new Map<string, string[]>();
  for (const c of CATEGORIES) req.set(c, requiredSections(cfg, c));
  return { allowedTags: allowedTagSet(cfg), allIds, deprecatedIds, inbound, requiredSections: req, wikiDir: cfg.wikiDir };
}

/**
 * Known secret formats. This is a regex net for common token shapes, not a guarantee: the protocol still
 * says to record where a secret lives and how to load it, never the value. Names are reported to the writer.
 */
const SECRET_PATTERNS: [string, RegExp][] = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["openai-key", /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35,}\b/],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["stripe-key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}\b/],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["slack-webhook", /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/],
  ["tailscale-key", /\btskey-(?:auth|api|client|scim)-[A-Za-z0-9-]{20,}/],
  ["azure-account-key", /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  // Doltap's own remote endpoint: /<64 hex>/mcp, and the bare path token after a slash. The URL is the credential.
  ["connector-url", /\/[0-9a-f]{64}\/mcp\b/i],
  ["path-token", /\/[0-9a-f]{64}(?![0-9a-z])/i],
  ["url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@/i],
  ["telegram-bot-token", /(?<![0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/],
  // `password = "..."` style, quoted (8+ chars) or unquoted (10+ chars that mix letters and digits).
  // Values starting with $ ( < { [ ` are placeholders or shell/env expressions ("where it lives", not the secret).
  ["credential-assignment", /(?:password|passwd|secret|api[_-]?key|access[_-]?key|token)\s*[:=]\s*(?:['"][^'"\s]{8,}['"]|(?=[^\s'"`]*\d)(?=[^\s'"`]*[A-Za-z])[^\s'"$<{[`(][^\s'"`]{9,})/i],
];

/** A match that is documentation, not a credential: the AWS docs key, YOUR_TOKEN_HERE, xxxx fillers, <angle placeholders>, ellipses. */
const PLACEHOLDER_RE = /EXAMPLE|YOUR_|xxxx|<[^>]*>|\.\.\.|…/i;

/**
 * Does `raw` contain a credential of this shape? Every match is checked against the placeholder list, and a
 * key-shaped match without a single digit (`sk-learn-preprocessing-pipeline-guide`) is prose, not a key.
 */
/** Remove a line break (and continuation indentation) that sits between two token characters, so a wrapped credential reads as one. */
export function joinWrappedLines(raw: string): string {
  return raw.replace(/([A-Za-z0-9_-])\r?\n[ \t]*(?=[A-Za-z0-9_])/g, "$1");
}

export function secretMatches(name: string, re: RegExp, raw: string): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of raw.matchAll(g)) {
    const text = m[0];
    if (PLACEHOLDER_RE.test(text)) continue;
    if (name === "openai-key" && !/\d/.test(text)) continue;
    return true;
  }
  return false;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Names of the credential shapes found in `raw` ("<name>" or "<name>, split across lines"), empty when clean. */
export function findSecrets(raw: string): string[] {
  const out: string[] = [];
  const joined = joinWrappedLines(raw);
  for (const [name, re] of SECRET_PATTERNS) {
    if (secretMatches(name, re, raw)) out.push(name);
    else if (joined !== raw && secretMatches(name, re, joined)) out.push(`${name}, split across lines`);
  }
  return out;
}

export function lintPage(page: Page, ctx: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const err = (rule: string, message: string) => issues.push({ id: page.id, level: "error", rule, message });
  const warn = (rule: string, message: string) => issues.push({ id: page.id, level: "warning", rule, message });
  const m = page.meta;
  const isHub = isCategoryHub(page.id);
  const category = page.id.split("/")[0];

  // Frontmatter
  if (!m.title) err("title-required", "frontmatter.title is required");
  if (!m.summary) err("summary-required", "frontmatter.summary is required");
  else if (m.summary.length > 200) err("summary-length", `summary is ${m.summary.length} chars; max 200`);
  if (!(CONFIDENCE as readonly string[]).includes(m.confidence)) err("confidence-invalid", `confidence must be one of ${CONFIDENCE.join("|")}, got "${m.confidence}"`);
  if (!DATE_RE.test(m.created)) err("created-invalid", `created must be YYYY-MM-DD, got "${m.created}"`);
  if (!DATE_RE.test(m.updated)) err("updated-invalid", `updated must be YYYY-MM-DD, got "${m.updated}"`);
  if (m.confidence === "verified" && m.sources.length === 0 && !isHub) warn("verified-needs-sources", "verified pages should list at least one source");
  if (m.review_by !== undefined) {
    if (!DATE_RE.test(m.review_by)) err("review-by-invalid", `review_by must be YYYY-MM-DD, got "${m.review_by}"`);
    else if (m.confidence !== "deprecated" && m.review_by < today()) warn("review-due", `review_by ${m.review_by} has passed; re-check the page against its sources, then wiki_verify (doltap verify) to move it forward`);
  }

  // Category / path
  if (page.id !== "Home") {
    if (!(CATEGORIES as readonly string[]).includes(category)) err("category-dir", `page is outside a known category directory (${CATEGORIES.join(", ")})`);
    if (m.category !== category) err("category-mismatch", `frontmatter.category "${m.category}" does not match directory "${category}"`);
    const slug = page.id.split("/").pop() ?? "";
    if (slug !== "_index" && !SLUG_RE.test(slug)) err("slug-format", `slug "${slug}" must be kebab-case`);
  }

  // Tags
  if (m.tags.length === 0 && !isHub) warn("tags-empty", "no tags; add at least one from _meta/tags.yaml");
  for (const t of m.tags) {
    if (ctx.allowedTags.has(t)) continue;
    const near = suggestTags(t, ctx.allowedTags);
    err("tag-unknown", `tag "${t}" is not in _meta/tags.yaml${near.length ? `; did you mean ${near.map((n) => `"${n}"`).join(", ")}?` : " (add it with wiki_add_tag / doltap tags add)"}`);
  }

  // Required sections (from the template). Under projects/ only the overview page follows the template;
  // topic pages (projects/<name>/<topic>) are free-form.
  if (!isHub && (CATEGORIES as readonly string[]).includes(category)) {
    const have = new Set(page.sections.filter((s) => s.level === 2).map((s) => s.heading.toLowerCase()));
    const followsTemplate = category !== "projects" || isProjectOverview(page.id);
    for (const req of followsTemplate ? ctx.requiredSections.get(category) ?? [] : []) {
      if (!have.has(req.toLowerCase())) err("section-missing", `required section "## ${req}" is missing`);
    }
    page.sections.forEach((s, i) => {
      // A section whose content lives entirely in ### subsections is not empty.
      const hasChildren = (page.sections[i + 1]?.level ?? 0) > s.level;
      if (s.level === 2 && s.heading !== "Related" && s.content.trim() === "" && !hasChildren) warn("section-empty", `section "## ${s.heading}" is empty; write N/A if it does not apply`);
    });
  }

  // Links
  for (const l of page.links) {
    if (!ctx.allIds.has(l) && l !== "_meta/PROTOCOL") err("link-broken", `link [[${l}]] points to a missing page`);
  }
  if (!isHub && (ctx.inbound.get(page.id) ?? 0) === 0) warn("orphan", "no inbound links; add it to the nearest _index manual list");

  // Attachments: relative links under wiki/_assets must exist, stay small and be of a known type.
  for (const a of assetRefsIn(page.raw, join(ctx.wikiDir, page.relPath), ctx.wikiDir)) {
    if (!existsSync(a.abs)) { err("asset-missing", `attachment ${a.target} does not exist (files go in wiki/_assets/<page id>/)`); continue; }
    const size = statSync(a.abs).size;
    if (size > ASSET_MAX_BYTES) warn("asset-too-large", `attachment ${a.target} is ${size} bytes (cap ${ASSET_MAX_BYTES}); shrink or link to where it lives`);
    const ext = assetExt(a.abs);
    if (!ASSET_TYPES.has(ext)) warn("asset-type", `attachment ${a.target}: .${ext || "(none)"} is not an attachment type (${[...ASSET_TYPES].join(", ")})`);
  }

  // Deprecated pages must point somewhere: `replaced_by` (set by wiki_deprecate) or at least a link in the body.
  if (m.confidence === "deprecated") {
    const rb = typeof m.replaced_by === "string" ? m.replaced_by : "";
    if (rb && !ctx.allIds.has(rb)) err("replaced-by-missing", `replaced_by "${rb}" is not an existing page`);
    else if (rb && ctx.deprecatedIds.has(rb)) warn("replaced-by-deprecated", `replaced_by "${rb}" is deprecated itself; point at its replacement`);
    else if (!rb && page.links.filter((l) => !l.endsWith("/_index")).length === 0) err("deprecated-no-replacement", "deprecated page must name its replacement (wiki_deprecate sets replaced_by)");
  } else if (m.replaced_by) warn("replaced-by-on-active", "replaced_by is set but the page is not deprecated");

  // Secrets
  // A key wrapped by an editor or a narrow terminal: also look at the text with line breaks between token
  // characters removed. Prose joins into harmless "wordword" runs; the patterns all need a specific prefix.
  for (const found of findSecrets(page.raw)) err("secret", `possible secret detected (${found})`);

  // Language: crude check for non-Latin scripts in prose.
  const nonLatin = (page.raw.match(/[ㄱ-힝぀-ヿ一-鿿]/g) ?? []).length;
  if (nonLatin > 20) warn("language", `${nonLatin} CJK characters found; wiki content must be English`);

  return issues;
}

export function hasErrors(issues: LintIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}

/** Wiki-level attachment checks: files nobody links (orphans) and credentials inside text attachments. */
export function lintAssets(cfg: WikiConfig, pages: Page[]): LintIssue[] {
  const files = walkAssets(cfg);
  if (!files.length) return [];
  const referenced = new Set<string>();
  for (const p of pages) for (const r of assetRefsIn(p.raw, join(cfg.wikiDir, p.relPath), cfg.wikiDir)) referenced.add(r.rel);
  const out: LintIssue[] = [];
  for (const f of files) {
    const id = `_assets/${f}`;
    if (!referenced.has(f)) out.push({ id, level: "warning", rule: "asset-orphan", message: "no page links this attachment; link it or remove it" });
    if (ASSET_TEXT_TYPES.has(assetExt(f))) {
      for (const found of findSecrets(readFileSync(join(assetsDir(cfg), f), "utf8"))) out.push({ id, level: "error", rule: "secret", message: `possible secret detected (${found})` });
    }
  }
  return out;
}
