import { CATEGORIES, CONFIDENCE, isCategoryHub, isProjectOverview, type WikiConfig } from "./config.js";
import type { Page } from "./page.js";
import { requiredSections } from "./template.js";
import { allowedTagSet } from "./tags.js";

export interface LintIssue {
  id: string;
  level: "error" | "warning";
  rule: string;
  message: string;
}

export interface LintContext {
  allowedTags: Set<string>;
  allIds: Set<string>;
  /** id -> number of inbound links (from the index). */
  inbound: Map<string, number>;
  requiredSections: Map<string, string[]>;
}

export function buildLintContext(cfg: WikiConfig, allIds: Set<string>, inbound: Map<string, number>): LintContext {
  const req = new Map<string, string[]>();
  for (const c of CATEGORIES) req.set(c, requiredSections(cfg, c));
  return { allowedTags: allowedTagSet(cfg), allIds, inbound, requiredSections: req };
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@/i],
  ["telegram-bot-token", /(?<![0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/],
  ["password-assignment", /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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

  // Category / path
  if (page.id !== "Home") {
    if (!(CATEGORIES as readonly string[]).includes(category)) err("category-dir", `page is outside a known category directory (${CATEGORIES.join(", ")})`);
    if (m.category !== category) err("category-mismatch", `frontmatter.category "${m.category}" does not match directory "${category}"`);
    const slug = page.id.split("/").pop() ?? "";
    if (slug !== "_index" && !SLUG_RE.test(slug)) err("slug-format", `slug "${slug}" must be kebab-case`);
  }

  // Tags
  if (m.tags.length === 0 && !isHub) warn("tags-empty", "no tags; add at least one from _meta/tags.yaml");
  for (const t of m.tags) if (!ctx.allowedTags.has(t)) err("tag-unknown", `tag "${t}" is not in _meta/tags.yaml`);

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

  // Deprecated pages must point somewhere
  if (m.confidence === "deprecated" && page.links.filter((l) => !l.endsWith("/_index")).length === 0) warn("deprecated-no-replacement", "deprecated page should link to its replacement");

  // Secrets
  for (const [name, re] of SECRET_PATTERNS) if (re.test(page.raw)) err("secret", `possible secret detected (${name})`);

  // Language: crude check for non-Latin scripts in prose.
  const nonLatin = (page.raw.match(/[ㄱ-힝぀-ヿ一-鿿]/g) ?? []).length;
  if (nonLatin > 20) warn("language", `${nonLatin} CJK characters found; wiki content must be English`);

  return issues;
}

export function hasErrors(issues: LintIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}
