import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CATEGORIES, isCategoryHub, today, type WikiConfig } from "./config.js";
import { WikiDb, type SearchHit } from "./db.js";
import { commitAndPush, commitMessage, emptyReport, pull, type SyncReport } from "./git.js";
import { buildLintContext, hasErrors, lintPage, type LintIssue } from "./lint.js";
import { withWriteLock } from "./lock.js";
import { parsePage, readPage, relPathFromId, replaceSection, serializePage, type Page, type PageMeta } from "./page.js";
import { getTemplate } from "./template.js";

export interface WriteResult {
  id: string;
  path: string;
  created: boolean;
  issues: LintIssue[];
  sync: SyncReport;
  /** Set when the write was refused because similar pages exist (upsert without force). */
  similar?: SearchHit[];
  refused?: string;
}

export interface UpsertInput {
  id: string;
  title?: string;
  summary?: string;
  tags?: string[];
  confidence?: string;
  sources?: string[];
  /** Full body (markdown below the frontmatter). If omitted on create, the category template body is used. */
  body?: string;
  force?: boolean;
}

function inboundMap(db: WikiDb): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of db.db.prepare("SELECT dst, COUNT(*) c FROM links GROUP BY dst").all() as { dst: string; c: number }[]) m.set(r.dst, r.c);
  return m;
}

export function lintOne(cfg: WikiConfig, db: WikiDb, page: Page): LintIssue[] {
  const ids = db.allIds();
  ids.add(page.id);
  const inbound = inboundMap(db);
  return lintPage(page, buildLintContext(cfg, ids, inbound));
}

/** The nearest existing `_index` above the page: `projects/demo/_index` for `projects/demo/environment`,
 *  the category hub for `projects/demo/_index` and for flat pages; null for category hubs themselves. */
function hubFor(cfg: WikiConfig, id: string): Page | null {
  const parts = id.split("/");
  if (!(CATEGORIES as readonly string[]).includes(parts[0]) || isCategoryHub(id)) return null;
  const top = parts.length - 1 - (parts[parts.length - 1] === "_index" ? 1 : 0);
  for (let depth = top; depth >= 1; depth--) {
    const hub = readPage(cfg, `${parts.slice(0, depth).join("/")}/_index`);
    if (hub) return hub;
  }
  return null;
}

/** Append `- [[id]] — summary` to the nearest hub's "Manual list" section when the page is not yet listed. */
function addToHub(cfg: WikiConfig, id: string, summary: string): string | null {
  const page = hubFor(cfg, id);
  if (!page) return null;
  if (page.body.includes(`[[${id}]]`)) return null;
  const sec = page.sections.find((s) => s.heading === "Manual list");
  const line = `- [[${id}]] — ${summary}`;
  const body = sec ? replaceSection(page.body, "Manual list", `${sec.content}\n${line}`.trim()) : `${page.body.trimEnd()}\n\n## Manual list\n\n${line}\n`;
  writeFileSync(page.absPath, serializePage(page.meta, body));
  return page.relPath;
}

/**
 * Create or fully replace a page. Runs pull → write → lint → commit → push.
 * Lint errors abort the write (file is restored) and are returned in `issues`.
 */
export function upsertPage(cfg: WikiConfig, input: UpsertInput): WriteResult {
  const relPath = relPathFromId(input.id);
  const category = input.id.split("/")[0];
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`id must start with a category (${CATEGORIES.join(", ")}): ${input.id}`);
  }
  return withWriteLock(cfg, () => {
  const sync = emptyReport();
  pull(cfg, sync);
  const db = new WikiDb(cfg);
  try {
    db.reindex();
    const abs = join(cfg.wikiDir, relPath);
    const existing = existsSync(abs) ? readPage(cfg, input.id) : null;

    if (!existing && !input.force) {
      const probe = `${input.title ?? ""} ${input.summary ?? ""} ${input.id.replace(/[/-]/g, " ")}`;
      const similar = db.similar(probe, 3);
      if (similar.length) {
        return { id: input.id, path: relPath, created: false, issues: [], sync, similar, refused: "similar pages exist; edit one of them or pass force=true" };
      }
    }

    let meta: PageMeta;
    let body: string;
    if (existing) {
      meta = { ...existing.meta };
      body = input.body ?? existing.body;
    } else {
      const tpl = parsePage(cfg, relPath, getTemplate(cfg, category));
      meta = { ...tpl.meta, category, created: today() };
      body = input.body ?? tpl.body;
    }
    if (input.title !== undefined) meta.title = input.title;
    if (input.summary !== undefined) meta.summary = input.summary;
    if (input.tags !== undefined) meta.tags = input.tags;
    if (input.confidence !== undefined) meta.confidence = input.confidence;
    if (input.sources !== undefined) meta.sources = input.sources;
    meta.updated = today();

    const raw = serializePage(meta, body);
    const page = parsePage(cfg, relPath, raw);
    const issues = lintOne(cfg, db, page).filter((i) => i.rule !== "orphan");
    if (hasErrors(issues)) {
      return { id: input.id, path: relPath, created: !existing, issues, sync, refused: "lint errors" };
    }

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, raw);
    const touched = [join("wiki", relPath)];
    const hubRel = addToHub(cfg, input.id, meta.summary);
    if (hubRel) touched.push(join("wiki", hubRel));
    db.reindex();
    commitAndPush(cfg, touched, commitMessage(cfg, existing ? "update" : "add", input.id), sync);
    return { id: input.id, path: relPath, created: !existing, issues, sync };
  } finally {
    db.close();
  }
  });
}

export interface PatchInput {
  id: string;
  section: string;
  content: string;
  mode?: "replace" | "append";
  /** Also bump `updated`. Default true. */
  touch?: boolean;
}

/** Replace or append one `## section` of an existing page. */
export function patchSection(cfg: WikiConfig, input: PatchInput): WriteResult {
  relPathFromId(input.id);
  return withWriteLock(cfg, () => {
  const sync = emptyReport();
  pull(cfg, sync);
  const db = new WikiDb(cfg);
  try {
    db.reindex();
    const page = readPage(cfg, input.id);
    if (!page) throw new Error(`page not found: ${input.id}`);
    const body = replaceSection(page.body, input.section, input.content, input.mode ?? "replace");
    const meta = { ...page.meta, updated: input.touch === false ? page.meta.updated : today() };
    const raw = serializePage(meta, body);
    const next = parsePage(cfg, page.relPath, raw);
    const issues = lintOne(cfg, db, next).filter((i) => i.rule !== "orphan");
    if (hasErrors(issues)) return { id: input.id, path: page.relPath, created: false, issues, sync, refused: "lint errors" };
    writeFileSync(page.absPath, raw);
    db.reindex();
    commitAndPush(cfg, [join("wiki", page.relPath)], commitMessage(cfg, "update", input.id, `section: ${input.section}`), sync);
    return { id: input.id, path: page.relPath, created: false, issues, sync };
  } finally {
    db.close();
  }
  });
}

export interface MetaPatch {
  id: string;
  confidence?: string;
  addSources?: string[];
  addTags?: string[];
  title?: string;
  summary?: string;
}

/** Update frontmatter only (promotion, deprecation, retagging). */
export function patchMeta(cfg: WikiConfig, input: MetaPatch): WriteResult {
  relPathFromId(input.id);
  return withWriteLock(cfg, () => {
  const sync = emptyReport();
  pull(cfg, sync);
  const db = new WikiDb(cfg);
  try {
    db.reindex();
    const page = readPage(cfg, input.id);
    if (!page) throw new Error(`page not found: ${input.id}`);
    const meta = { ...page.meta, updated: today() };
    if (input.confidence) meta.confidence = input.confidence;
    if (input.title) meta.title = input.title;
    if (input.summary) meta.summary = input.summary;
    if (input.addSources?.length) meta.sources = [...new Set([...meta.sources, ...input.addSources])];
    if (input.addTags?.length) meta.tags = [...new Set([...meta.tags, ...input.addTags])];
    const raw = serializePage(meta, page.body);
    const next = parsePage(cfg, page.relPath, raw);
    const issues = lintOne(cfg, db, next).filter((i) => i.rule !== "orphan");
    if (hasErrors(issues)) return { id: input.id, path: page.relPath, created: false, issues, sync, refused: "lint errors" };
    writeFileSync(page.absPath, raw);
    db.reindex();
    const action = input.confidence === "deprecated" ? "deprecate" : "update";
    commitAndPush(cfg, [join("wiki", page.relPath)], commitMessage(cfg, action, input.id, `meta: ${Object.keys(input).filter((k) => k !== "id").join(", ")}`), sync);
    return { id: input.id, path: page.relPath, created: false, issues, sync };
  } finally {
    db.close();
  }
  });
}

/** Lint every page. Orphan warnings are computed from the link graph. */
export function lintAll(cfg: WikiConfig, ids?: string[]): LintIssue[] {
  const db = new WikiDb(cfg);
  try {
    const { pages } = db.reindex();
    const ctx = buildLintContext(cfg, db.allIds(), inboundMap(db));
    const out: LintIssue[] = [];
    for (const p of pages) if (!ids || ids.includes(p.id)) out.push(...lintPage(p, ctx));
    return out;
  } finally {
    db.close();
  }
}

/** Regenerate wiki/_meta/index.md (gitignored): one line per page, grouped by category. */
export function writeIndexMd(cfg: WikiConfig): string {
  const db = new WikiDb(cfg);
  try {
    db.reindex();
    const rows = db.list({ includeDeprecated: true });
    const lines: string[] = ["# Index", "", `Generated ${new Date().toISOString()} on ${cfg.hostname}. Do not edit; run \`doltap reindex\`.`, ""];
    for (const cat of CATEGORIES) {
      const inCat = rows.filter((r) => r.category === cat && !isCategoryHub(r.id));
      if (!inCat.length) continue;
      lines.push(`## ${cat}`, "");
      for (const r of inCat) lines.push(`- \`${r.id}\` [${r.confidence}] ${r.summary}`);
      lines.push("");
    }
    const out = lines.join("\n");
    const p = join(cfg.wikiDir, "_meta", "index.md");
    writeFileSync(p, out);
    return relative(cfg.root, p);
  } finally {
    db.close();
  }
}

export function readIndexMd(cfg: WikiConfig): string {
  const p = join(cfg.wikiDir, "_meta", "index.md");
  if (!existsSync(p)) writeIndexMd(cfg);
  return readFileSync(p, "utf8");
}
