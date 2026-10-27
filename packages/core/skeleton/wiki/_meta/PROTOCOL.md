# Doltap Protocol

Rules that agents and humans follow when reading and writing this wiki. Also served as the MCP resource `wiki://protocol`.

## 1. When to read

Before starting a task, run `wiki_search` (or `doltap search`) for related pages. In particular:

- When starting a repetitive task such as deploy, build, release, or environment setup
- When implementing a feature that recurs across projects: auth, retry, caching, logging
- When you need version-specific behavior or limits of an external library or API
- When you wonder "why is it done this way?" (check `decisions/`)

Check `confidence` on every result:

| confidence | Meaning | Action |
|---|---|---|
| `verified` | Confirmed in real work | Trust it and follow it |
| `draft` | Written once, not yet re-verified | Use as a hint, verify yourself. If it holds, promote with `wiki_verify` and say what confirmed it |
| `deprecated` | No longer valid | Do not follow. Use the page named in `replaced_by` (also linked at the top of the body) |

## 2. When to write

Create or update a page when any of these is true:

- You are solving the same problem for the **second** time (the first time you cannot know it is a pattern)
- You found a **pitfall** that is missing from or contradicts official documentation
- You wrote code or a procedure that is reusable across projects
- You made a technology choice whose rationale is not visible from the code alone
- You confirmed that an existing page is wrong or outdated

Do **not** write:

- Session logs, work journals, one-off debugging narratives
- Anything that is obvious from reading the code or official docs
- Source layout of a specific project (that belongs in the project's CLAUDE.md/README; exception: a one-line summary plus link under `projects/`)
- Secret values: tokens, API keys, passwords, private keys, credentials inside URLs (lint blocks common formats). Record where the secret lives instead; see below
- Unverified guesses (if you must, mark `confidence: draft` and state what is uncertain)

### Private information and secrets

This wiki is private to its owner and the owner's agents. Internal hostnames, internal URLs and IPs, service architecture and account names may be written. Keep in mind that every page an agent reads is sent to its model provider and stays in session transcripts.

Secret values never go in a page: git history keeps them forever and one leaked page or connector URL would expose all of them. Write the **location** and the **load command** instead, so an agent can use the secret without it entering the wiki:

```md
- Billing API key: macOS Keychain, service `billing-api` (on the build machine)
  load: `export BILLING_API_KEY=$(security find-generic-password -s billing-api -w)`
- Router admin password: 1Password item "Office router"
- Bot token: `.env` of the bot repo, key `BOT_TOKEN`
```

Lint catches common token formats and Doltap's own connector URL, but it is a safety net, not a guarantee. If a secret value was written by mistake, rotate the secret at its issuer; deleting the line does not remove it from history.

## 3. Classification table

Decide the category before creating a page. Each category has its own template and required sections.

| Core question | Category | Required sections | Examples |
|---|---|---|---|
| **How do I do X** (reproducible procedure) | `howto/` | Prerequisites, Steps, Verification, Pitfalls | PyPI release, Docker multi-stage build |
| **How do I implement X** (code is the deliverable) | `patterns/` | Problem, Solution, Variations, Anti-patterns, Used in | FastAPI JWT refresh, exponential backoff |
| **What is X** (summary of external facts) | `reference/` | Key facts, Details, Verified on | Node 22 `node:sqlite` feature coverage |
| **Why X instead of Y** (rationale for a choice) | `decisions/` | Context, Options, Decision, Consequences | Why better-sqlite3 over node:sqlite |
| Context specific to one project | `projects/<name>/` | Overview page `_index`: Overview, Environment, Wiki pages used by this project, Project-only notes. Topic pages: free-form | A project's deployment environment |

When it is ambiguous:

- A procedure that contains code snippets is `howto`. When the code itself is the result, it is `patterns`.
- When a fact and a choice based on that fact appear together, split them into `reference` and `decisions` and link both ways.
- A pattern used by only one project goes under `projects/<name>/`. The moment a second project uses it, move it to `patterns/` and leave a link at the old location.
- Each project is a directory: `projects/<name>/_index` is the overview (follows the projects template) and `projects/<name>/<topic>` pages hold one topic each (environment, deployment, maintenance, …) with any sections plus `## Related`. The tools list the overview in `projects/_index` and topic pages in the project's `_index`.

## 4. Page format

### Path and id

- id = path relative to `wiki/` without `.md`, e.g. `howto/deploy-pypi`
- Slugs are English kebab-case. Prefer verb-object order: `deploy-pypi`, `rotate-jwt-secret`
- Renaming a file changes its id. Avoid it. If unavoidable, leave a `deprecated` page at the old path that links to the new one.

### Frontmatter (required)

```yaml
---
title: Release a package to PyPI
category: howto
summary: Build a pyproject-based package, upload it to PyPI with trusted publishing, and push the tag.
tags: [python, release, ci]
confidence: draft
created: 2026-10-18
updated: 2026-10-18
sources:
  - https://docs.pypi.org/trusted-publishers/
---
```

- `title`: human-readable title
- `category`: must match the directory (checked by lint)
- `summary`: 1–2 sentences, max 200 characters. It is shown verbatim in search results and the index, so write it so that **a reader can decide whether to open the page from the summary alone**
- `tags`: only values listed in `_meta/tags.yaml`. Add a new tag first with `wiki_add_tag` (`doltap tags add`); lint suggests the closest existing tag on a typo
- `confidence`: `draft` | `verified` | `deprecated`
- `created`, `updated`: ISO dates
- `sources`: URLs, SPEC ids, session ids — the evidence. May be empty on a draft; `wiki_verify` appends its evidence here
- `replaced_by`, `verified_by`, `verified_on`: written by `wiki_deprecate` and `wiki_verify`; do not set them by hand

### Body

- Follow the section layout of the template (`_meta/templates/<category>.md`). Do not leave a section empty; write "N/A" if it does not apply.
- No length limit, but one page covers one topic. If two topics are mixed, split and link.
- Code blocks carry a language tag.
- Write in English. Identifiers, commands, tags, and slugs are English.

### Links

- Link between pages with `[[howto/deploy-pypi]]`. Link to a section with `[[howto/deploy-pypi#Pitfalls]]`.
- Put related pages in the body's "Related" section as links, not in frontmatter. Backlinks are computed automatically.
- A page with zero inbound links (orphan) triggers a lint warning. The tools list every page in the "Manual list" of its nearest `_index` automatically (regenerated from the page summaries on every write and sync), so a page is never an orphan by accident; do not edit those lists by hand.

## 5. Update rules

- Edit existing pages **by section** (`wiki_patch_section`), not by overwriting the whole page. This minimizes conflicts with concurrent edits from other machines. An unknown heading is refused (the existing headings are listed) unless you pass `create: true`.
- Every read returns a `rev`. Pass it back as `base_rev` on `wiki_patch_section`, `wiki_set_meta` or `wiki_upsert`: the write is refused as stale when the page changed in between, so nobody's edit is lost silently. Re-read and retry.
- Set `updated` to today whenever the content changes. Typo fixes are exempt.
- When you find wrong content, fix it rather than deleting it, and leave a one-line note in "Pitfalls" or "Changelog" saying what was wrong and why.
- When a page is no longer valid, do not delete it. Create or pick the replacement, then `wiki_deprecate` (`doltap deprecate`): it sets `confidence: deprecated` and `replaced_by`, and puts a banner with the link at the top of the body. A deprecated page without a replacement fails lint.
- Promotion `draft` → `verified` requires that another session or another machine followed the page and it worked. Use `wiki_verify` (`doltap verify`) with that evidence; the tool records it in `sources` plus `verified_by` / `verified_on`, and refuses the session that created the page. A session is the MCP server process (stdio), the client name plus the day (HTTP), or `DOLTAP_SESSION` / `CLAUDE_CODE_SESSION_ID` for the CLI.

## 6. Check before creating

`wiki_upsert` creates pages. An existing id is refused: edit it with `wiki_patch_section` / `wiki_set_meta`, or rewrite it entirely with `replace: true` and the `base_rev` you read. Before creating, it searches for similar pages. If a similar page exists:

1. Same topic → do not create; add or edit a section of the existing page instead
2. Different but related topic → create the new page with `force: true` and link both ways
3. Genuinely separate → save with `force: true`

## 7. Commits

Every write automatically runs `pull --rebase → lint → commit → push`. Commit message format:

```
wiki: <add|update|deprecate> <id>

[host:<hostname>] [agent:<client>] [session:<id>]
```

On a conflict, the losing version is preserved as `<id>.conflict-<hostname>.md` and a warning is returned. Whoever finds such a file (`wiki_get` lists `conflict_copies`) merges the two versions and finishes with `wiki_resolve_conflict` (`doltap resolve`), which writes the merged body, deletes the copies and commits. `_meta/tags.yaml` merges automatically (union), so concurrent tag additions never conflict.
