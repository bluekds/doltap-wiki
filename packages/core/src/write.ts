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
  /** Revision of the page after the write (see Page.rev). */
  rev?: string;
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
  /** Create even if similar pages exist. */
  force?: boolean;
  /** Overwrite an existing page. Without it an existing id is refused (use patchSection/patchMeta for edits). */
  replace?: boolean;
  /** Revision the caller read (Page.rev). The write is refused when the page changed since. */
  baseRev?: string;
}

function staleRefusal(current: string, base: string | undefined): string | null {
  return base && base !== current ? `stale: page changed since you read it (current rev ${current}, yours ${base}); read it again and retry` : null;
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

/** The id of the nearest hub above a page: `projects/demo/_index` for `projects/demo/environment` (when it exists),
 *  the category hub for `projects/demo/_index` and for flat pages; null for category hubs themselves. */
export function hubIdFor(id: string, ids: Set<string>): string | null {
  const parts = id.split("/");
  if (!(CATEGORIES as readonly string[]).includes(parts[0]) || isCategoryHub(id)) return null;
  const top = parts.length - 1 - (parts[parts.length - 1] === "_index" ? 1 : 0);
  for (let depth = top; depth >= 1; depth--) {
    const hub = `${parts.slice(0, depth).join("/")}/_index`;
    if (ids.has(hub)) return hub;
  }
  return null;
}

const HUB_LIST = "Manual list";

/**
 * Rewrite every hub's "Manual list" section from the index: one `- [[id]] — summary` line per page whose
 * nearest hub it is, sorted by id, deprecated pages marked. Intro text above the list is kept. Returns the
 * wiki-relative paths of hubs whose body changed. Derived content, so nothing drifts after a summary change,
 * a deprecation or a hand edit.
 */
export function regenerateHubLists(cfg: WikiConfig, db: WikiDb): string[] {
  const rows = db.list({ includeDeprecated: true });
  const ids = new Set(rows.map((r) => r.id));
  const members = new Map<string, typeof rows>();
  for (const r of rows) {
    const hub = hubIdFor(r.id, ids);
    if (hub) members.set(hub, [...(members.get(hub) ?? []), r]);
  }
  const hubs = rows.filter((r) => isCategoryHub(r.id) && r.id !== "Home").map((r) => r.id);
  for (const h of members.keys()) if (!hubs.includes(h)) hubs.push(h);
  const changed: string[] = [];
  for (const hubId of hubs) {
    const page = readPage(cfg, hubId);
    if (!page) continue;
    const list = (members.get(hubId) ?? [])
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => `- [[${r.id}]] — ${r.confidence === "deprecated" ? "(deprecated) " : ""}${r.summary.replace(/\s+/g, " ").trim()}`);
    const sec = page.sections.find((s) => s.heading === HUB_LIST && s.level === 2);
    if (!sec && !list.length) continue;
    const intro = sec ? sec.content.split("\n").filter((l) => !/^- \[\[/.test(l)).join("\n").trim() : "";
    const content = [intro, list.join("\n")].filter(Boolean).join("\n\n");
    const body = replaceSection(page.body, HUB_LIST, content, "replace", { create: true });
    if (body === page.body) continue;
    writeFileSync(page.absPath, serializePage(page.meta, body));
    changed.push(page.relPath);
  }
  return changed;
}

/** Regenerate hub lists outside a page write (sync, scheduler) and commit them. Returns root-relative paths that changed. */
export function refreshHubs(cfg: WikiConfig): string[] {
  return withWriteLock(cfg, () => {
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      const changed = regenerateHubLists(cfg, db).map((rel) => `wiki/${rel}`); // posix, like git pathspecs and SyncReport paths
      if (changed.length) {
        db.reindex();
        commitAndPush(cfg, changed, commitMessage(cfg, "refresh", "hub lists"));
      }
      return changed;
    } finally {
      db.close();
    }
  });
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

    if (existing) {
      if (!input.replace) return { id: input.id, path: relPath, created: false, issues: [], sync, refused: `page ${input.id} exists; edit it with patch_section or set_meta, or pass replace=true (with base_rev from get) to overwrite it` };
      const stale = staleRefusal(existing.rev, input.baseRev);
      if (stale) return { id: input.id, path: relPath, created: false, issues: [], sync, refused: stale };
    }
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
    db.reindex();
    const touched = [join("wiki", relPath), ...regenerateHubLists(cfg, db).map((rel) => join("wiki", rel))];
    commitAndPush(cfg, touched, commitMessage(cfg, existing ? "update" : "add", input.id), sync);
    return { id: input.id, path: relPath, created: !existing, issues, sync, rev: page.rev };
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
  /** Add the section when the heading does not exist (otherwise an unknown heading is an error). */
  create?: boolean;
  baseRev?: string;
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
    const stale = staleRefusal(page.rev, input.baseRev);
    if (stale) return { id: input.id, path: page.relPath, created: false, issues: [], sync, refused: stale };
    const body = replaceSection(page.body, input.section, input.content, input.mode ?? "replace", { create: input.create });
    const meta = { ...page.meta, updated: input.touch === false ? page.meta.updated : today() };
    const raw = serializePage(meta, body);
    const next = parsePage(cfg, page.relPath, raw);
    const issues = lintOne(cfg, db, next).filter((i) => i.rule !== "orphan");
    if (hasErrors(issues)) return { id: input.id, path: page.relPath, created: false, issues, sync, refused: "lint errors" };
    writeFileSync(page.absPath, raw);
    db.reindex();
    commitAndPush(cfg, [join("wiki", page.relPath)], commitMessage(cfg, "update", input.id, `section: ${input.section}`), sync);
    return { id: input.id, path: page.relPath, created: false, issues, sync, rev: next.rev };
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
  baseRev?: string;
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
    const stale = staleRefusal(page.rev, input.baseRev);
    if (stale) return { id: input.id, path: page.relPath, created: false, issues: [], sync, refused: stale };
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
    const touched = [join("wiki", page.relPath), ...regenerateHubLists(cfg, db).map((rel) => join("wiki", rel))];
    commitAndPush(cfg, touched, commitMessage(cfg, action, input.id, `meta: ${Object.keys(input).filter((k) => k !== "id" && k !== "baseRev").join(", ")}`), sync);
    return { id: input.id, path: page.relPath, created: false, issues, sync, rev: next.rev };
  } finally {
    db.close();
  }
  });
}

/** Lint every page. Orphan warnings are computed from the link graph. */
export function lintAll(cfg: WikiConfig, ids?: string[]): LintIssue[] {
  const db = new WikiDb(cfg);
  try {
    const { pages, broken } = db.reindex();
    const ctx = buildLintContext(cfg, db.allIds(), inboundMap(db));
    const out: LintIssue[] = [];
    for (const b of broken) if (!ids || ids.includes(b.id)) out.push({ id: b.id, level: "error", rule: "frontmatter-invalid", message: `${b.relPath}: ${b.error}` });
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
