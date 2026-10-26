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
| `draft` | Written once, not yet re-verified | Use as a hint, verify yourself. If it holds, promote to `verified` |
| `deprecated` | No longer valid | Do not follow. Use the replacement link in the body |

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
- Secrets, tokens, keys, internal URLs (lint blocks these)
- Unverified guesses (if you must, mark `confidence: draft` and state what is uncertain)

## 3. Classification table

Decide the category before creating a page. Each category has its own template and required sections.

| Core question | Category | Required sections | Examples |
|---|---|---|---|
| **How do I do X** (reproducible procedure) | `howto/` | Prerequisites, Steps, Verification, Pitfalls | PyPI release, Docker multi-stage build |
| **How do I implement X** (code is the deliverable) | `patterns/` | Problem, Solution, Variations, Anti-patterns | FastAPI JWT refresh, exponential backoff |
| **What is X** (summary of external facts) | `reference/` | Key facts, Verified on | Node 22 `node:sqlite` feature coverage |
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
- `tags`: only values listed in `_meta/tags.yaml`. Add a new tag to tags.yaml first if needed
- `confidence`: `draft` | `verified` | `deprecated`
- `created`, `updated`: ISO dates
- `sources`: URLs, SPEC ids, session ids — the evidence. May be empty, but required when promoting to `verified`

### Body

- Follow the section layout of the template (`_meta/templates/<category>.md`). Do not leave a section empty; write "N/A" if it does not apply.
- No length limit, but one page covers one topic. If two topics are mixed, split and link.
- Code blocks carry a language tag.
- Write in English. Identifiers, commands, tags, and slugs are English.

### Links

- Link between pages with `[[howto/deploy-pypi]]`. Link to a section with `[[howto/deploy-pypi#Pitfalls]]`.
- Put related pages in the body's "Related" section as links, not in frontmatter. Backlinks are computed automatically.
- A page with zero inbound links (orphan) triggers a lint warning. At minimum, link it from the category hub (`<category>/_index.md`).

## 5. Update rules

- Edit existing pages **by section** (`wiki_patch_section`), not by overwriting the whole page. This minimizes conflicts with concurrent edits from other machines.
- Set `updated` to today whenever the content changes. Typo fixes are exempt.
- When you find wrong content, fix it rather than deleting it, and leave a one-line note in "Pitfalls" or "Changelog" saying what was wrong and why.
- When a page is no longer valid, do not delete it. Set `confidence: deprecated` and put a link to the replacement at the top of the body.
- Promotion `draft` → `verified` requires: another session or another machine followed the page and succeeded. Add the evidence to `sources` when promoting.

## 6. Check before creating

`wiki_upsert` searches for similar pages before saving. If a similar page exists:

1. Same topic → do not create; add or edit a section of the existing page instead
2. Different but related topic → create the new page and link both ways
3. Genuinely separate → save with `force: true`

## 7. Commits

Every write automatically runs `pull --rebase → lint → commit → push`. Commit message format:

```
wiki: <add|update|deprecate> <id>

[host:<hostname>] [agent:<client>] [session:<id>]
```

On a conflict, the losing version is preserved as `<id>.conflict-<hostname>.md` and a warning is returned. Whoever finds such a file merges the two versions and deletes the conflict file.
