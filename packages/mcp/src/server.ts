import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addTag,
  CATEGORIES,
  CONFIDENCE,
  conflictCopiesOf,
  deprecatePage,
  get,
  resolveConflict,
  verifyPage,
  getTemplate,
  lintAll,
  list,
  listConflictFiles,
  loadTags,
  patchMeta,
  patchSection,
  protocolText,
  readIndexMd,
  refreshHubs,
  related,
  search,
  syncAll,
  upsertPage,
  WikiDb,
  writeIndexMd,
  audit,
  isCategoryHub,
  publishHostStats,
  PAGE_ID_RE,
  type WikiConfig,
} from "@bluekds/doltap-core";

const CategoryEnum = z.enum(CATEGORIES);
const ConfidenceEnum = z.enum(CONFIDENCE);
/** Any existing page id (`howto/x`, `projects/p/_index`, `Home`). Core re-checks it before touching the filesystem. */
const PageId = z.string().max(200).regex(PAGE_ID_RE, "page id: letters, digits, - and _ in /-separated segments");

const CLASSIFICATION = `Choose the category by the question the page answers:
- howto: "How do I do X" (reproducible procedure; sections Prerequisites/Steps/Verification/Pitfalls)
- patterns: "How do I implement X" (code is the deliverable; Problem/Solution/Variations/Anti-patterns/Used in)
- reference: "What is X" (summary of external facts; Key facts/Details/Verified on)
- decisions: "Why X instead of Y" (Context/Options/Decision/Consequences)
- projects: context for one project (Overview/Environment/Wiki pages used by this project/Project-only notes)
Do not write session logs, one-off debugging, anything obvious from code or docs, or secret values (record where a secret lives and how to load it instead). Write in English.`;

function text(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function errorText(e: unknown) {
  return { isError: true as const, ...text({ error: e instanceof Error ? e.message : String(e) }) };
}

export interface ServerOptions {
  /** Write tools answer with an error. Used for read-only HTTP client tokens. */
  readOnly?: boolean;
}

/** Build a fresh MCP server bound to one wiki config. stdio uses one; HTTP creates one per request (stateless). */
export function createServer(cfg: WikiConfig, opts: ServerOptions = {}): McpServer {
const readOnly = () => (opts.readOnly ? errorText(`this connection uses a read-only token (${cfg.agent}); writes need a full-access token`) : null);
const INSTRUCTIONS = `Doltap is a shared wiki for agents (howto, patterns, reference, decisions, projects). Rules in short; the full protocol is the resource wiki://protocol.
- Search first: call wiki_search before repetitive or cross-project work (deploy, build, release, auth, retry, config, library versions). Then wiki_get the page or one section.
- confidence: verified = follow it; draft = use as a hint and verify, then promote with wiki_verify and evidence (the session that created a page cannot verify it); deprecated = do not follow, use replaced_by.
- Edit by section (wiki_patch_section) rather than replacing pages. wiki_upsert refuses an existing id unless replace=true with the base_rev you read; a stale base_rev is refused so nobody's edit is lost silently.
- Write when you solved something a second time, hit an undocumented pitfall, or made a choice whose rationale is not in the code. Not session logs, not things obvious from code or docs.
- Never write secret values (tokens, keys, passwords, connector URLs); record where the secret lives and how to load it. Internal hosts are fine.
- English only. Tags only from wiki://tags (add one with wiki_add_tag). Hub lists are generated; do not edit them. Deprecate with wiki_deprecate, finish a conflict with wiki_resolve_conflict.`;

const server = new McpServer({ name: "doltap", version: "0.2.0" }, { instructions: INSTRUCTIONS });

// ------------------------------------------------------------------ resources
server.registerResource("protocol", "wiki://protocol", { title: "Doltap protocol", description: "Rules for reading, writing, and classifying wiki pages. Read before writing.", mimeType: "text/markdown" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "text/markdown", text: protocolText(cfg) }],
}));
server.registerResource("index", "wiki://index", { title: "Doltap index", description: "One line per page: id, confidence, summary.", mimeType: "text/markdown" }, async (uri) => {
  writeIndexMd(cfg);
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: readIndexMd(cfg) }] };
});
server.registerResource("tags", "wiki://tags", { title: "Doltap tags", description: "Allowed tag vocabulary.", mimeType: "application/json" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(loadTags(cfg), null, 2) }],
}));

// ------------------------------------------------------------------ read tools
server.registerTool(
  "wiki_search",
  {
    title: "Search the wiki",
    description: "Full-text search over shared knowledge pages (procedures, code patterns, reference facts, decisions). Call this before starting any repetitive task (deploy, build, auth, retry, config) or when you need version-specific facts. Returns id, confidence, tags, summary. Then call wiki_get for the page or a section.",
    inputSchema: {
      query: z.string().describe("Free text; terms are stemmed and prefix-matched"),
      category: CategoryEnum.optional(),
      tag: z.string().optional(),
      confidence: ConfidenceEnum.optional(),
      limit: z.number().int().min(1).max(50).default(10),
      include_deprecated: z.boolean().default(false),
      include_hubs: z.boolean().default(false).describe("Also return category hub pages (Home, <category>/_index)"),
    },
  },
  async (a) => {
    try {
      const { hits, sync } = search(cfg, a.query, { category: a.category, tag: a.tag, confidence: a.confidence, limit: a.limit, includeDeprecated: a.include_deprecated, includeHubs: a.include_hubs });
      return text({ hits: hits.map((h) => ({ id: h.id, title: h.title, confidence: h.confidence, replaced_by: h.replaced_by ?? undefined, tags: h.tags, summary: h.summary, updated: h.updated, matched: h.matched })), notes: sync.messages });
    } catch (e) { return errorText(e); }
  },
);

server.registerTool(
  "wiki_get",
  {
    title: "Read a wiki page",
    description: "Return a page body (or a single ## section to save tokens) with its frontmatter, rev, section list, and backlinks. Check `confidence`: verified = trust; draft = verify yourself and promote via wiki_verify if it holds; deprecated = do not follow, read `replaced_by` instead.",
    inputSchema: {
      id: PageId.describe("Page id, e.g. howto/deploy-pypi"),
      section: z.string().optional().describe("Heading of one ## section, e.g. Pitfalls"),
    },
  },
  async (a) => {
    try {
      const { result } = get(cfg, a.id, a.section);
      if (!result) return errorText(`page not found: ${a.id}`);
      const { page, text: body, backlinks } = result;
      return text({ id: a.id, rev: page.rev, meta: page.meta, replaced_by: page.meta.replaced_by ?? undefined, conflict_copies: conflictCopiesOf(cfg, a.id), section: a.section ?? null, sections: page.sections.map((s) => s.heading), text: body, links: page.links, backlinks });
    } catch (e) { return errorText(e); }
  },
);

server.registerTool(
  "wiki_list",
  {
    title: "List wiki pages",
    description: "List pages by category and/or tag. Use when you want to browse rather than search.",
    inputSchema: { category: CategoryEnum.optional(), tag: z.string().optional(), confidence: ConfidenceEnum.optional(), include_deprecated: z.boolean().default(false) },
  },
  async (a) => {
    try {
      const { rows } = list(cfg, { category: a.category, tag: a.tag, confidence: a.confidence, includeDeprecated: a.include_deprecated });
      return text(rows.filter((r) => !isCategoryHub(r.id)).map((r) => ({ id: r.id, confidence: r.confidence, tags: r.tags, summary: r.summary })));
    } catch (e) { return errorText(e); }
  },
);

server.registerTool(
  "wiki_related",
  { title: "Related pages", description: "Pages linked from, linking to, or sharing tags with the given page. Use to expand from one hit to adjacent knowledge.", inputSchema: { id: PageId } },
  async (a) => {
    try {
      const { result } = related(cfg, a.id);
      const slim = (rows: { id: string; summary: string; confidence: string }[]) => rows.map((r) => ({ id: r.id, confidence: r.confidence, summary: r.summary }));
      return text({ outlinks: slim(result.outlinks), backlinks: slim(result.backlinks), shared_tags: slim(result.sharedTags) });
    } catch (e) { return errorText(e); }
  },
);

server.registerTool(
  "wiki_template",
  { title: "Page template", description: `Return the template for a category so you can fill it in for wiki_upsert. ${CLASSIFICATION}`, inputSchema: { category: CategoryEnum } },
  async (a) => { try { return text(getTemplate(cfg, a.category)); } catch (e) { return errorText(e); } },
);

// ------------------------------------------------------------------ write tools
server.registerTool(
  "wiki_upsert",
  {
    title: "Create a wiki page",
    description: `Create a page. An existing id is refused unless replace=true (prefer wiki_patch_section / wiki_set_meta for edits); with replace, pass base_rev from wiki_get so a page changed by someone else in the meantime is not overwritten. Write when: solving the same problem a second time, a pitfall not in the docs, reusable cross-project code, or a decision whose rationale is not visible in code. ${CLASSIFICATION}
Rules: body must follow the category template sections (get it with wiki_template); summary <= 200 chars and self-sufficient; tags only from wiki://tags; link related pages with [[id]]. The page is linted, similar pages are checked (refused unless force=true), then committed and pushed. Hub lists are updated automatically.`,
    inputSchema: {
      id: z.string().regex(/^(howto|patterns|reference|decisions|projects)\/[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)?$/).describe("<category>/<kebab-slug>, e.g. patterns/retry-backoff"),
      title: z.string(),
      summary: z.string().max(200),
      tags: z.array(z.string()).min(1),
      body: z.string().describe("Markdown below the frontmatter, following the category template sections"),
      sources: z.array(z.string()).default([]).describe("Evidence: URLs, SPEC ids, session ids"),
      force: z.boolean().default(false).describe("Create even if similar pages exist"),
      replace: z.boolean().default(false).describe("Overwrite an existing page (whole body and frontmatter)"),
      base_rev: z.string().optional().describe("The rev returned by wiki_get for this page; the write is refused if the page changed since"),
    },
  },
  async (a) => {
    try {
      const ro = readOnly(); if (ro) return ro;
      const r = upsertPage(cfg, { id: a.id, title: a.title, summary: a.summary, tags: a.tags, body: a.body, confidence: "draft", sources: a.sources, force: a.force, replace: a.replace, baseRev: a.base_rev });
      if (r.refused) return { isError: true as const, ...text({ refused: r.refused, issues: r.issues, similar: r.similar?.map((s) => ({ id: s.id, summary: s.summary, overlap: s.snippet })) }) };
      return text({ id: r.id, created: r.created, rev: r.rev, warnings: r.issues, pushed: r.sync.pushed, notes: r.sync.messages, conflicts: r.sync.conflicts });
    } catch (e) { return errorText(e); }
  },
);

server.registerTool(
  "wiki_patch_section",
  {
    title: "Edit one section of a page",
    description: "Replace or append the content of one ## section. Preferred way to update existing pages (minimizes conflicts with other machines). Use mode=append to add a pitfall or note without rewriting the section. An unknown heading is an error (the existing headings are listed) unless create=true. Bumps `updated` unless touch=false.",
    inputSchema: {
      id: PageId,
      section: z.string().describe("Existing ## heading such as Pitfalls (case-insensitive)"),
      content: z.string(),
      mode: z.enum(["replace", "append"]).default("replace"),
      touch: z.boolean().default(true),
      create: z.boolean().default(false).describe("Add the section as a new ## heading when it does not exist"),
      base_rev: z.string().optional().describe("rev from wiki_get; refused if the page changed since"),
    },
  },
  async (a) => {
    try {
      const ro = readOnly(); if (ro) return ro;
      const r = patchSection(cfg, { id: a.id, section: a.section, content: a.content, mode: a.mode, touch: a.touch, create: a.create, baseRev: a.base_rev });
      if (r.refused) return { isError: true as const, ...text({ refused: r.refused, issues: r.issues }) };
      return text({ id: r.id, rev: r.rev, warnings: r.issues, pushed: r.sync.pushed, notes: r.sync.messages, conflicts: r.sync.conflicts });
    } catch (e) { return errorText(e); }
  },
);

server.registerTool(
  "wiki_set_meta",
  {
    title: "Update page frontmatter",
    description: "Add sources or tags, or fix title/summary. To promote use wiki_verify; to deprecate use wiki_deprecate (confidence here is limited to draft).",
    inputSchema: {
      id: PageId,
      confidence: z.enum(["draft"]).optional().describe("Only draft; verified and deprecated have dedicated tools"),
      add_sources: z.array(z.string()).default([]),
      add_tags: z.array(z.string()).default([]),
      title: z.string().optional(),
      summary: z.string().max(200).optional(),
      base_rev: z.string().optional().describe("rev from wiki_get; refused if the page changed since"),
    },
  },
  async (a) => {
    try {
      const ro = readOnly(); if (ro) return ro;
      const r = patchMeta(cfg, { id: a.id, confidence: a.confidence, addSources: a.add_sources, addTags: a.add_tags, title: a.title, summary: a.summary, baseRev: a.base_rev });
      if (r.refused) return { isError: true as const, ...text({ refused: r.refused, issues: r.issues }) };
      return text({ id: r.id, rev: r.rev, warnings: r.issues, pushed: r.sync.pushed, notes: r.sync.messages });
    } catch (e) { return errorText(e); }
  },
);

server.registerTool(
  "wiki_verify",
  {
    title: "Promote a page to verified",
    description: "Mark a draft page verified after you followed it and it worked. Requires evidence (what you did, where, what confirmed it); it is appended to sources and verified_by/verified_on are recorded. The session that created the page cannot verify it.",
    inputSchema: { id: PageId, evidence: z.string().min(10).describe("e.g. 'Followed on build-box 2026-10-27; release 1.4.2 published'"), base_rev: z.string().optional() },
  },
  async (a) => {
    try {
      const ro = readOnly(); if (ro) return ro;
      const r = verifyPage(cfg, { id: a.id, evidence: a.evidence, baseRev: a.base_rev });
      if (r.refused) return { isError: true as const, ...text({ refused: r.refused, issues: r.issues }) };
      return text({ id: r.id, rev: r.rev, warnings: r.issues, pushed: r.sync.pushed, notes: r.sync.messages });
    } catch (e) { return errorText(e); }
  },
);

server.registerTool(
  "wiki_deprecate",
  {
    title: "Deprecate a page",
    description: "Mark a page deprecated and point to its replacement: sets confidence=deprecated and replaced_by, adds a banner at the top of the body, updates the hub list. The replacement must exist (create it first). Pages are never deleted.",
    inputSchema: { id: PageId, replaced_by: PageId.describe("The page to use instead"), reason: z.string().optional(), base_rev: z.string().optional() },
  },
  async (a) => {
    try {
      const ro = readOnly(); if (ro) return ro;
      const r = deprecatePage(cfg, { id: a.id, replacedBy: a.replaced_by, reason: a.reason, baseRev: a.base_rev });
      if (r.refused) return { isError: true as const, ...text({ refused: r.refused, issues: r.issues }) };
      return text({ id: r.id, rev: r.rev, warnings: r.issues, pushed: r.sync.pushed, notes: r.sync.messages });
    } catch (e) { return errorText(e); }
  },
);

server.registerTool(
  "wiki_resolve_conflict",
  {
    title: "Resolve a conflict file",
    description: "After a sync reported conflicts, read the page (wiki_get shows conflict_copies) and the copy, then write the merged body here; the conflict copies are deleted and the result committed. Pass take=conflict to keep the copy's body unchanged.",
    inputSchema: { id: PageId, body: z.string().optional().describe("Merged markdown body (below the frontmatter)"), take: z.enum(["conflict"]).optional() },
  },
  async (a) => {
    try {
      const ro = readOnly(); if (ro) return ro;
      const r = resolveConflict(cfg, { id: a.id, body: a.body, take: a.take });
      if (r.refused) return { isError: true as const, ...text({ refused: r.refused, issues: r.issues }) };
      return text({ id: r.id, rev: r.rev, warnings: r.issues, pushed: r.sync.pushed, notes: r.sync.messages });
    } catch (e) { return errorText(e); }
  },
);

server.registerTool(
  "wiki_add_tag",
  {
    title: "Add a tag to the vocabulary",
    description: "Add a new tag to wiki://tags (kebab-case, one-line description, optional group) so it can be used on pages. Check the existing tags first; prefer an existing one when it fits.",
    inputSchema: { tag: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), description: z.string().min(3).max(120), group: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).optional().describe("Group heading in tags.yaml, e.g. language, platform, domain; default other") },
  },
  async (a) => {
    try {
      const ro = readOnly(); if (ro) return ro;
      const r = addTag(cfg, { tag: a.tag, description: a.description, group: a.group });
      return text({ tag: r.tag, group: r.group, pushed: r.sync.pushed, notes: r.sync.messages });
    } catch (e) { return errorText(e); }
  },
);

// ------------------------------------------------------------------ maintenance tools
server.registerTool(
  "wiki_lint",
  { title: "Lint pages", description: "Validate all pages (or the given ids) against the protocol: frontmatter, tags, required sections, links, orphans, secrets.", inputSchema: { ids: z.array(PageId).default([]) } },
  async (a) => { try { return text(lintAll(cfg, a.ids.length ? a.ids : undefined)); } catch (e) { return errorText(e); } },
);

server.registerTool(
  "wiki_sync",
  { title: "Sync with remote", description: "Pull, push pending commits, reindex, regenerate hub lists, and list conflict files (*.conflict-<host>.md) that need a manual merge and pages whose frontmatter does not parse.", inputSchema: {} },
  async () => {
    try {
      const ro = readOnly(); if (ro) return ro;
      const report = syncAll(cfg);
      const hubs = refreshHubs(cfg);
      const db = new WikiDb(cfg);
      const r = db.reindex();
      publishHostStats(cfg, db, report);
      db.close();
      writeIndexMd(cfg);
      return text({ ...report, pages: r.total, reindexed: r.indexed, removed: r.removed, hub_lists_refreshed: hubs, broken_pages: r.broken, conflict_files: listConflictFiles(cfg) });
    } catch (e) { return errorText(e); }
  },
);

server.registerTool(
  "wiki_audit",
  {
    title: "Audit the wiki",
    description: "Maintenance report across all hosts: unreferenced pages (deprecate candidates), stale pages (re-verify), lingering drafts, orphans, deprecated pages still linked, conflict files, unused tags, most-read pages. Use when asked to clean up or review the wiki.",
    inputSchema: { unreferenced_days: z.number().int().default(90), stale_days: z.number().int().default(90), draft_days: z.number().int().default(30) },
  },
  async (a) => { try { return text(audit(cfg, { unreferencedDays: a.unreferenced_days, staleDays: a.stale_days, draftDays: a.draft_days })); } catch (e) { return errorText(e); } },
);

return server;
}
