import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CATEGORIES, isCategoryHub, today, type WikiConfig } from "./config.js";
import { WikiDb, type SearchHit } from "./db.js";
import { assertOnBranch, commitAndPush, commitMessage, emptyReport, git, pull, type SyncReport } from "./git.js";
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
  return lintPage(page, buildLintContext(cfg, ids, inbound, deprecatedIds(db)));
}

function deprecatedIds(db: WikiDb): Set<string> {
  return new Set(db.list({ includeDeprecated: true }).filter((r) => r.confidence === "deprecated").map((r) => r.id));
}

/** Symlinks under wiki/ as lint errors: they are skipped by every read, and a link can point at any file on the host. */
function symlinkIssues(cfg: WikiConfig, db: WikiDb): LintIssue[] {
  return db.listSymlinks().map((abs) => {
    const rel = relative(cfg.wikiDir, abs).split("\\").join("/");
    return { id: rel.replace(/\.md$/, ""), level: "error" as const, rule: "symlink", message: `${rel} is a symbolic link; pages must be regular files (remove it)` };
  });
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
export function refreshHubs(cfg: WikiConfig, report?: SyncReport): string[] {
  return withWriteLock(cfg, () => {
    assertOnBranch(cfg);
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      const changed = regenerateHubLists(cfg, db).map((rel) => `wiki/${rel}`); // posix, like git pathspecs and SyncReport paths
      if (changed.length) {
        db.reindex();
        commitAndPush(cfg, changed, commitMessage(cfg, "refresh", "hub lists"), report);
      }
      return changed;
    } finally {
      db.close();
    }
  });
}

/** The rev to return from a write: when the page is itself a hub whose list was just regenerated, the on-disk rev differs from the one computed before. */
function revAfterHubs(cfg: WikiConfig, id: string, written: Page, changedHubs: string[]): string {
  if (!changedHubs.includes(written.relPath)) return written.rev;
  return readPage(cfg, id)?.rev ?? written.rev;
}

/**
 * Create or fully replace a page. Runs pull → write → lint → commit → push.
 * Lint errors abort the write (file is restored) and are returned in `issues`.
 */
export function upsertPage(cfg: WikiConfig, input: UpsertInput): WriteResult {
  const relPath = relPathFromId(input.id);
  if (input.confidence === "verified") throw new Error("confidence verified cannot be set directly; promote with verify (evidence, verified_by/verified_on)");
  const category = input.id.split("/")[0];
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`id must start with a category (${CATEGORIES.join(", ")}): ${input.id}`);
  }
  return withWriteLock(cfg, () => {
  assertOnBranch(cfg);
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
    const hubs = regenerateHubLists(cfg, db);
    const touched = [join("wiki", relPath), ...hubs.map((rel) => join("wiki", rel))];
    commitAndPush(cfg, touched, commitMessage(cfg, existing ? "update" : "add", input.id), sync);
    return { id: input.id, path: relPath, created: !existing, issues, sync, rev: revAfterHubs(cfg, input.id, page, hubs) };
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
  assertOnBranch(cfg);
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
  assertOnBranch(cfg);
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
    if (input.confidence === "verified") throw new Error("confidence verified cannot be set directly; promote with verify (evidence, verified_by/verified_on)");
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

export interface DeprecateInput {
  id: string;
  /** The page to use instead. Must exist and not be deprecated itself. */
  replacedBy: string;
  reason?: string;
  baseRev?: string;
}

/**
 * Mark a page deprecated: `confidence: deprecated`, `replaced_by: <id>` in the frontmatter, and a banner as
 * the first line of the body so readers of the raw page see it too. Hub lists mark it; search returns
 * `replaced_by`.
 */
export function deprecatePage(cfg: WikiConfig, input: DeprecateInput): WriteResult {
  relPathFromId(input.id);
  relPathFromId(input.replacedBy);
  if (input.replacedBy === input.id) throw new Error("a page cannot replace itself");
  return withWriteLock(cfg, () => {
    assertOnBranch(cfg);
    const sync = emptyReport();
    pull(cfg, sync);
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      const page = readPage(cfg, input.id);
      if (!page) throw new Error(`page not found: ${input.id}`);
      const target = readPage(cfg, input.replacedBy);
      if (!target) throw new Error(`replacement ${input.replacedBy} does not exist; create it first`);
      if (target.meta.confidence === "deprecated") throw new Error(`replacement ${input.replacedBy} is deprecated itself`);
      const stale = staleRefusal(page.rev, input.baseRev);
      if (stale) return { id: input.id, path: page.relPath, created: false, issues: [], sync, refused: stale };
      const banner = `> **Deprecated.** Use [[${input.replacedBy}]] instead.${input.reason ? ` ${input.reason.replace(/\s+/g, " ").trim()}` : ""}`;
      const body = `${banner}\n\n${page.body.replace(/^> \*\*Deprecated\.\*\*[^\n]*\n+/, "")}`;
      const meta: PageMeta = { ...page.meta, confidence: "deprecated", replaced_by: input.replacedBy, updated: today() };
      const raw = serializePage(meta, body);
      const next = parsePage(cfg, page.relPath, raw);
      const issues = lintOne(cfg, db, next).filter((i) => i.rule !== "orphan");
      if (hasErrors(issues)) return { id: input.id, path: page.relPath, created: false, issues, sync, refused: "lint errors" };
      writeFileSync(page.absPath, raw);
      db.reindex();
      const hubs = regenerateHubLists(cfg, db);
      const touched = [join("wiki", page.relPath), ...hubs.map((rel) => join("wiki", rel))];
      commitAndPush(cfg, touched, commitMessage(cfg, "deprecate", input.id, `replaced by ${input.replacedBy}`), sync);
      return { id: input.id, path: page.relPath, created: false, issues, sync, rev: revAfterHubs(cfg, input.id, next, hubs) };
    } finally {
      db.close();
    }
  });
}

export interface VerifyInput {
  id: string;
  /** What confirmed the page: where it was followed, what happened. Recorded in `sources`. */
  evidence: string;
  baseRev?: string;
}

/** `[session:x]` of the commit that created the page, from git history (null when unknown). */
function creatingSession(cfg: WikiConfig, relPath: string): string | null {
  const log = git(cfg, ["log", "--diff-filter=A", "--format=%B", "--", `wiki/${relPath}`], { allowFail: true });
  const m = /\[session:([^\]]+)\]/.exec(log.stdout);
  return m ? m[1] : null;
}

/**
 * Promote draft → verified with evidence. The session that created the page cannot verify it: promotion
 * means someone else followed the page and it worked. Records `verified_by` (host/agent) and `verified_on`.
 */
export function verifyPage(cfg: WikiConfig, input: VerifyInput): WriteResult {
  relPathFromId(input.id);
  const evidence = input.evidence.replace(/\s+/g, " ").trim();
  if (!evidence) throw new Error("evidence is required: say where the page was followed and what confirmed it");
  return withWriteLock(cfg, () => {
    assertOnBranch(cfg);
    const sync = emptyReport();
    pull(cfg, sync);
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      const page = readPage(cfg, input.id);
      if (!page) throw new Error(`page not found: ${input.id}`);
      const refuse = (why: string): WriteResult => ({ id: input.id, path: page.relPath, created: false, issues: [], sync, refused: why });
      const stale = staleRefusal(page.rev, input.baseRev);
      if (stale) return refuse(stale);
      if (page.meta.confidence === "verified") return refuse(`${input.id} is already verified (by ${String(page.meta.verified_by ?? "unknown")}); add evidence with set_meta add_sources instead`);
      if (page.meta.confidence === "deprecated") return refuse(`${input.id} is deprecated; nothing to verify`);
      const creator = creatingSession(cfg, page.relPath);
      if (creator && cfg.session && creator === cfg.session) return refuse(`refusing self-promotion: ${input.id} was created in this same session (${cfg.session}); another session or machine must follow the page first`);
      const meta: PageMeta = {
        ...page.meta,
        confidence: "verified",
        sources: [...new Set([...page.meta.sources, evidence])],
        verified_by: `${cfg.hostname}/${cfg.agent}`,
        verified_on: today(),
        updated: today(),
      };
      const raw = serializePage(meta, page.body);
      const next = parsePage(cfg, page.relPath, raw);
      const issues = lintOne(cfg, db, next).filter((i) => i.rule !== "orphan");
      if (hasErrors(issues)) return { ...refuse("lint errors"), issues };
      writeFileSync(page.absPath, raw);
      db.reindex();
      commitAndPush(cfg, [join("wiki", page.relPath)], commitMessage(cfg, "verify", input.id, `evidence: ${evidence}`), sync);
      return { id: input.id, path: page.relPath, created: false, issues, sync, rev: next.rev };
    } finally {
      db.close();
    }
  });
}

export interface ResolveInput {
  id: string;
  /** The merged body. Omit with `take: "conflict"` to keep the conflict copy's body as is. */
  body?: string;
  take?: "conflict";
  /** rev from get; refused as stale when the page changed since (someone else may have edited it while you merged). */
  baseRev?: string;
}

/** Conflict copies of a page in this clone: `<id>.conflict-<host>.md`, wiki-relative. */
export function conflictCopiesOf(cfg: WikiConfig, id: string): string[] {
  const dir = dirname(join(cfg.wikiDir, relPathFromId(id)));
  if (!existsSync(dir)) return [];
  const slug = id.split("/").pop()!;
  const re = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.conflict-[^./]+\\.md$`);
  return readdirSyncSafe(dir).filter((f) => re.test(f)).map((f) => join(dirname(relPathFromId(id)), f).split("\\").join("/"));
}

function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * Finish a conflict: write the merged body to the page (frontmatter kept, `updated` bumped), delete every
 * `<id>.conflict-<host>.md` copy, commit and push. MCP-only agents could not do this before.
 */
export function resolveConflict(cfg: WikiConfig, input: ResolveInput): WriteResult {
  relPathFromId(input.id);
  return withWriteLock(cfg, () => {
    assertOnBranch(cfg);
    const sync = emptyReport();
    pull(cfg, sync);
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      const copies = conflictCopiesOf(cfg, input.id);
      const copy = copies.length === 1 ? parsePage(cfg, copies[0], readFileSync(join(cfg.wikiDir, copies[0]), "utf8")) : null;
      let page = readPage(cfg, input.id);
      // The upstream deleted the page while this clone edited it: the conflict copy is all that is left, so restore from it.
      const restoring = !page;
      if (!page) {
        if (!copies.length) throw new Error(`page not found: ${input.id}`);
        if (!copy) throw new Error(`page ${input.id} is gone upstream and has several conflict copies (${copies.join(", ")}); keep one and retry`);
        const relPath = relPathFromId(input.id);
        page = { ...copy, relPath, absPath: join(cfg.wikiDir, relPath) };
      }
      const stale = restoring ? null : staleRefusal(page.rev, input.baseRev);
      if (stale) return { id: input.id, path: page.relPath, created: false, issues: [], sync, refused: stale };
      let body = input.body;
      if (input.take === "conflict") {
        if (!copies.length) throw new Error(`no conflict copy for ${input.id}`);
        if (!copy) throw new Error(`multiple conflict copies for ${input.id} (${copies.join(", ")}); merge them and pass the body`);
        body = copy.body;
      }
      if (body === undefined) throw new Error("pass the merged body, or take: \"conflict\" to keep the conflict copy");
      const meta: PageMeta = { ...page.meta, updated: today() };
      const raw = serializePage(meta, body);
      const next = parsePage(cfg, page.relPath, raw);
      const issues = lintOne(cfg, db, next).filter((i) => i.rule !== "orphan");
      if (hasErrors(issues)) return { id: input.id, path: page.relPath, created: false, issues, sync, refused: "lint errors" };
      // A copy left by an autostash conflict is untracked; `git add` of a deleted untracked path fails, so stage only tracked copies.
      const tracked = copies.filter((c) => git(cfg, ["ls-files", "--error-unmatch", "--", `wiki/${c}`], { allowFail: true }).ok);
      writeFileSync(page.absPath, raw);
      for (const c of copies) unlinkSync(join(cfg.wikiDir, c));
      db.reindex();
      const hubs = regenerateHubLists(cfg, db);
      const touched = [join("wiki", page.relPath), ...tracked.map((c) => `wiki/${c}`), ...hubs.map((rel) => join("wiki", rel))];
      commitAndPush(cfg, touched, commitMessage(cfg, "resolve conflict", input.id, `${restoring ? "restored from the conflict copy (deleted upstream); " : ""}${copies.length ? `removed: ${copies.join(", ")}` : ""}`.trim() || undefined), sync);
      return { id: input.id, path: page.relPath, created: restoring, issues, sync, rev: revAfterHubs(cfg, input.id, next, hubs) };
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
    const ctx = buildLintContext(cfg, db.allIds(), inboundMap(db), deprecatedIds(db));
    const out: LintIssue[] = [];
    for (const b of broken) if (!ids || ids.includes(b.id)) out.push({ id: b.id, level: "error", rule: "frontmatter-invalid", message: `${b.relPath}: ${b.error}` });
    for (const i of symlinkIssues(cfg, db)) if (!ids || ids.includes(i.id)) out.push(i);
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
