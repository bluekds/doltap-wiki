# MCP tool reference

Generated from the server's zod schemas by `npm run reference` (`doltap-mcp --reference`); do not edit by hand. Server `doltap` 0.9.0: 16 tools, 3 resources.

## Server instructions

What every client receives at connect time:

> Doltap is a shared wiki for agents (howto, patterns, reference, decisions, projects). Rules in short; the full protocol is the resource wiki://protocol.
> - Search first: call wiki_search before repetitive or cross-project work (deploy, build, release, auth, retry, config, library versions). Then wiki_get the page or one section.
> - confidence: verified = follow it; draft = use as a hint and verify, then promote with wiki_verify and evidence (the session that created a page cannot verify it); deprecated = do not follow, use replaced_by.
> - Edit by section (wiki_patch_section) rather than replacing pages. wiki_upsert refuses an existing id unless replace=true with the base_rev you read; a stale base_rev is refused so nobody's edit is lost silently.
> - Write when you solved something a second time, hit an undocumented pitfall, or made a choice whose rationale is not in the code. Not session logs, not things obvious from code or docs.
> - Never write secret values (tokens, keys, passwords, connector URLs); record where the secret lives and how to load it. Internal hosts are fine.
> - English only. Tags only from wiki://tags (add one with wiki_add_tag). Hub lists are generated; do not edit them. Deprecate with wiki_deprecate, finish a conflict with wiki_resolve_conflict.

## Resources

| URI | Title | Description | Type |
|---|---|---|---|
| `wiki://protocol` | Doltap protocol | Rules for reading, writing, and classifying wiki pages. Read before writing. | `text/markdown` |
| `wiki://index` | Doltap index | One line per page: id, confidence, summary. | `text/markdown` |
| `wiki://tags` | Doltap tags | Allowed tag vocabulary. | `application/json` |

## Tools

Writes: the tool changes the wiki (commits and pushes) and is refused on a read-only token.

| Tool | Writes | Title |
|---|---|---|
| [`wiki_search`](#wiki_search) |  | Search the wiki |
| [`wiki_get`](#wiki_get) |  | Read a wiki page |
| [`wiki_list`](#wiki_list) |  | List wiki pages |
| [`wiki_related`](#wiki_related) |  | Related pages |
| [`wiki_history`](#wiki_history) |  | Page history |
| [`wiki_template`](#wiki_template) |  | Page template |
| [`wiki_upsert`](#wiki_upsert) | yes | Create a wiki page |
| [`wiki_patch_section`](#wiki_patch_section) | yes | Edit one section of a page |
| [`wiki_set_meta`](#wiki_set_meta) | yes | Update page frontmatter |
| [`wiki_verify`](#wiki_verify) | yes | Verify a page (promote, or record a re-check) |
| [`wiki_deprecate`](#wiki_deprecate) | yes | Deprecate a page |
| [`wiki_resolve_conflict`](#wiki_resolve_conflict) | yes | Resolve a conflict file |
| [`wiki_add_tag`](#wiki_add_tag) | yes | Add a tag to the vocabulary |
| [`wiki_lint`](#wiki_lint) |  | Lint pages |
| [`wiki_sync`](#wiki_sync) | yes | Sync with remote |
| [`wiki_audit`](#wiki_audit) | yes | Audit the wiki |

### wiki_search

**Search the wiki** (read-only)

Full-text search over shared knowledge pages (procedures, code patterns, reference facts, decisions). Call this before starting any repetitive task (deploy, build, auth, retry, config) or when you need version-specific facts. Ranked by text match, then verified over draft and a small lift for pages created or verified in the last 30 days; age is never a penalty. Returns id, confidence, tags, summary. Then call wiki_get for the page or a section.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | yes |  | Free text; terms are stemmed and prefix-matched (at most 500 chars) |
| `category` | enum | no |  | (one of `howto`, `patterns`, `reference`, `decisions`, `projects`) |
| `tag` | string | no |  | (at most 200 chars) |
| `confidence` | enum | no |  | (one of `draft`, `verified`, `deprecated`) |
| `limit` | integer | no | `10` | (1–50) |
| `include_deprecated` | boolean | no | `false` |  |
| `include_hubs` | boolean | no | `false` | Also return category hub pages (Home, &lt;category&gt;/_index) |

### wiki_get

**Read a wiki page** (read-only)

Return a page body (or a single ## section to save tokens) with its frontmatter, rev, section list, and backlinks. Check `confidence`: verified = trust; draft = verify yourself and promote via wiki_verify if it holds; deprecated = do not follow, read `replaced_by` instead. `review_due: true` means the page's review_by date has passed: its facts may have drifted, so treat it as a hint, re-check, and wiki_verify it if it still holds.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes |  | Page id, e.g. howto/deploy-pypi (at most 200 chars; matches `^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$`) |
| `section` | string | no |  | Heading of one ## section, e.g. Pitfalls (at most 200 chars) |

### wiki_list

**List wiki pages** (read-only)

List pages by category and/or tag. Use when you want to browse rather than search.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `category` | enum | no |  | (one of `howto`, `patterns`, `reference`, `decisions`, `projects`) |
| `tag` | string | no |  | (at most 200 chars) |
| `confidence` | enum | no |  | (one of `draft`, `verified`, `deprecated`) |
| `include_deprecated` | boolean | no | `false` |  |

### wiki_related

**Related pages** (read-only)

Pages linked from, linking to, or sharing tags with the given page. Use to expand from one hit to adjacent knowledge.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes |  | (at most 200 chars; matches `^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$`) |

### wiki_history

**Page history** (read-only)

Commits that changed a page, newest first: rev, date, action (add/update/verify/deprecate/…), host, agent, session and the note (verify evidence, deprecate reason). Use to see who changed what and when before trusting or editing a page.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes |  | (at most 200 chars; matches `^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$`) |
| `limit` | integer | no |  | (1–200) |

### wiki_template

**Page template** (read-only)

Return the template for a category so you can fill it in for wiki_upsert. Choose the category by the question the page answers:
- howto: "How do I do X" (reproducible procedure; sections Prerequisites/Steps/Verification/Pitfalls)
- patterns: "How do I implement X" (code is the deliverable; Problem/Solution/Variations/Anti-patterns/Used in)
- reference: "What is X" (summary of external facts; Key facts/Details/Verified on)
- decisions: "Why X instead of Y" (Context/Options/Decision/Consequences)
- projects: context for one project (Overview/Environment/Wiki pages used by this project/Project-only notes)
Do not write session logs, one-off debugging, anything obvious from code or docs, or secret values (record where a secret lives and how to load it instead). Write in English.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `category` | enum | yes |  | (one of `howto`, `patterns`, `reference`, `decisions`, `projects`) |

### wiki_upsert

**Create a wiki page** (writes)

Create a page. An existing id is refused unless replace=true (prefer wiki_patch_section / wiki_set_meta for edits); with replace, pass base_rev from wiki_get so a page changed by someone else in the meantime is not overwritten. Write when: solving the same problem a second time, a pitfall not in the docs, reusable cross-project code, or a decision whose rationale is not visible in code. Choose the category by the question the page answers:
- howto: "How do I do X" (reproducible procedure; sections Prerequisites/Steps/Verification/Pitfalls)
- patterns: "How do I implement X" (code is the deliverable; Problem/Solution/Variations/Anti-patterns/Used in)
- reference: "What is X" (summary of external facts; Key facts/Details/Verified on)
- decisions: "Why X instead of Y" (Context/Options/Decision/Consequences)
- projects: context for one project (Overview/Environment/Wiki pages used by this project/Project-only notes)
Do not write session logs, one-off debugging, anything obvious from code or docs, or secret values (record where a secret lives and how to load it instead). Write in English.
Rules: body must follow the category template sections (get it with wiki_template); summary &lt;= 200 chars and self-sufficient; tags only from wiki://tags; link related pages with [[id]]. The page is linted, similar pages are checked (refused unless force=true), then committed and pushed. Hub lists are updated automatically.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes |  | &lt;category&gt;/&lt;kebab-slug&gt;, e.g. patterns/retry-backoff; a project overview is projects/&lt;slug&gt;/_index (matches `^(howto\|patterns\|reference\|decisions\|projects)\/[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)?$\|^projects\/[a-z0-9]+(-[a-z0-9]+)*\/_index$`) |
| `title` | string | yes |  | (at most 200 chars) |
| `summary` | string | yes |  | (at most 200 chars) |
| `tags` | string[] | yes |  | (at least 1 item) |
| `body` | string | yes |  | Markdown below the frontmatter, following the category template sections (at most 256000 chars) |
| `sources` | string[] | no | `[]` | Evidence: URLs, SPEC ids, session ids |
| `force` | boolean | no | `false` | Create even if similar pages exist |
| `replace` | boolean | no | `false` | Overwrite an existing page (whole body and frontmatter). Its confidence is kept; a deprecated page is refused |
| `review_by` | string | no |  | When to re-check the page against its sources: days from today ("60"), a YYYY-MM-DD date, or "none". Set it on howto/reference pages that depend on a tool version or an external service; decisions and projects never expire |
| `base_rev` | string | no |  | The rev returned by wiki_get for this page; the write is refused if the page changed since |

### wiki_patch_section

**Edit one section of a page** (writes)

Replace or append the content of one ## section. Preferred way to update existing pages (minimizes conflicts with other machines). Use mode=append to add a pitfall or note without rewriting the section. An unknown heading is an error (the existing headings are listed) unless create=true. Bumps `updated` unless touch=false.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes |  | (at most 200 chars; matches `^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$`) |
| `section` | string | yes |  | Existing ## heading such as Pitfalls (case-insensitive) (at most 200 chars) |
| `content` | string | yes |  | (at most 256000 chars) |
| `mode` | enum | no | `"replace"` | (one of `replace`, `append`) |
| `touch` | boolean | no | `true` |  |
| `create` | boolean | no | `false` | Add the section as a new ## heading when it does not exist |
| `base_rev` | string | no |  | rev from wiki_get; refused if the page changed since |

### wiki_set_meta

**Update page frontmatter** (writes)

Add sources or tags, fix title/summary, or set review_by (the date a howto/reference page should be re-checked). To promote use wiki_verify; to deprecate use wiki_deprecate (confidence here is limited to draft).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes |  | (at most 200 chars; matches `^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$`) |
| `confidence` | enum | no |  | Only draft; verified and deprecated have dedicated tools (one of `draft`) |
| `add_sources` | string[] | no | `[]` |  |
| `add_tags` | string[] | no | `[]` |  |
| `title` | string | no |  | (at most 200 chars) |
| `summary` | string | no |  | (at most 200 chars) |
| `review_by` | string | no |  | When to re-check the page against its sources: days from today ("60"), a YYYY-MM-DD date, or "none". Set it on howto/reference pages that depend on a tool version or an external service; decisions and projects never expire |
| `base_rev` | string | no |  | rev from wiki_get; refused if the page changed since |

### wiki_verify

**Verify a page (promote, or record a re-check)** (writes)

Mark a draft page verified after you followed it and it worked. Requires evidence (what you did, where, what confirmed it); it is appended to sources and verified_by/verified_on are recorded. The session that created the page cannot promote it. On a page that is already verified this records a re-check: verified_on and review_by move forward, the body and updated stay; use it when a page's review_by has passed and the page is still right.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes |  | (at most 200 chars; matches `^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$`) |
| `evidence` | string | yes |  | e.g. 'Followed on build-box 2026-10-27; release 1.4.2 published' (at least 10 chars; at most 2000 chars) |
| `review_by` | string | no |  | Next re-check: days from today, a date, or none. Omitted on a re-check: the previous interval is kept |
| `base_rev` | string | no |  |  |

### wiki_deprecate

**Deprecate a page** (writes)

Mark a page deprecated and point to its replacement: sets confidence=deprecated and replaced_by, adds a banner at the top of the body, updates the hub list. The replacement must exist (create it first). Pages are never deleted.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes |  | (at most 200 chars; matches `^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$`) |
| `replaced_by` | string | yes |  | The page to use instead (at most 200 chars; matches `^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$`) |
| `reason` | string | no |  | (at most 2000 chars) |
| `base_rev` | string | no |  |  |

### wiki_resolve_conflict

**Resolve a conflict file** (writes)

After a sync reported conflicts, read the page (wiki_get shows conflict_copies) and the copy, then write the merged body here; the conflict copies are deleted and the result committed. Pass take=conflict to keep the copy's body unchanged.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes |  | (at most 200 chars; matches `^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$`) |
| `body` | string | no |  | Merged markdown body (below the frontmatter) (at most 256000 chars) |
| `take` | enum | no |  | (one of `conflict`) |
| `base_rev` | string | no |  | rev from wiki_get; refused as stale if the page changed while you merged |

### wiki_add_tag

**Add a tag to the vocabulary** (writes)

Add a new tag to wiki://tags (kebab-case, one-line description, optional group) so it can be used on pages. Check the existing tags first; prefer an existing one when it fits.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `tag` | string | yes |  | (matches `^[a-z0-9]+(-[a-z0-9]+)*$`) |
| `description` | string | yes |  | (at least 3 chars; at most 120 chars) |
| `group` | string | no |  | Group heading in tags.yaml, e.g. language, platform, domain; default other (matches `^[a-z0-9]+(-[a-z0-9]+)*$`) |

### wiki_lint

**Lint pages** (read-only)

Validate all pages (or the given ids) against the protocol: frontmatter, tags, required sections, links, orphans, secrets.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `ids` | string[] | no | `[]` | (items match `^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$`) |

### wiki_sync

**Sync with remote** (writes)

Pull, push pending commits, reindex, regenerate hub lists, and list conflict files (*.conflict-&lt;host&gt;.md) that need a manual merge and pages whose frontmatter does not parse.

No parameters.

### wiki_audit

**Audit the wiki** (writes)

Maintenance report across all hosts: unreviewed pages (review_by passed, or no re-check within the category window: re-check against sources, then wiki_verify), unreferenced pages (nobody read them: a discoverability check, not a deprecation list), lingering drafts, orphans, deprecated pages still linked, conflict files, unused tags, most-read pages. decisions/ and projects/ pages never age. Use when asked to clean up or review the wiki.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `unreferenced_days` | integer | no | `90` |  |
| `review_days` | integer | no |  | Override the per-category review window (reference 180, howto 365) for pages without review_by |
| `draft_days` | integer | no | `30` |  |
| `report` | boolean | no | `false` | Also write the report to wiki/_meta/reports/&lt;date&gt;.md and commit it (newest 12 kept); the weekly maintenance pass reads it |
