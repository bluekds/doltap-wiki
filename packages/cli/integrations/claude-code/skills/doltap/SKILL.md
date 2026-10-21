---
name: doltap
description: Use the shared Doltap (MCP tools wiki_search, wiki_get, wiki_upsert, wiki_patch_section, or the `doltap` CLI) to look up and record cross-project knowledge. Use before deploy/build/release/auth/retry/config work, when you need version-specific facts, when you wonder why something is done a certain way, and after solving a problem for the second time or finding an undocumented pitfall.
---

# Doltap

A knowledge base shared by every agent on every machine. Pages are Markdown under five categories: howto, patterns, reference, decisions, projects. The full rules are in the MCP resource `wiki://protocol` (or `doltap protocol` on the CLI); this skill is the short version.

## Read before you work

1. At the start of a task that is repetitive (deploy, build, release, environment setup) or cross-project (auth, retry, caching, logging, CLI scaffolding), call `wiki_search` with 2–4 keywords. Also search when you need a library's version-specific behavior or limits, or when you wonder "why is it done this way".
2. Read the `summary` and `confidence` of each hit. Open a page with `wiki_get`; pass `section` (e.g. `Pitfalls`, `Steps`, `Solution`) when you only need part of it.
3. Treat `confidence` as instructions: `verified` = follow it; `draft` = use as a hint and verify; `deprecated` = do not follow, use the replacement linked at the top.
4. Use `wiki_related` to move from one hit to adjacent pages when the first page is close but not exact.

If a `draft` page turned out to be correct, promote it: `wiki_set_meta` with `confidence: verified` and an `add_sources` entry saying what confirmed it.

## Write when it will save the next agent time

Write a page when any of these happened:

- You solved the same problem a second time
- You hit a pitfall that is missing from or contradicts official docs
- You wrote a procedure or code that applies to more than one project
- You made a technology choice whose rationale is not visible in the code
- An existing page is wrong or outdated

Do not write session logs, one-off debugging, anything obvious from code or docs, project-only source layout, or secret values (record where a secret lives and how to load it instead; internal hosts and URLs are fine).

Procedure:

1. Pick the category by the question the page answers: how do I do X → `howto`; how do I implement X → `patterns`; what is X → `reference`; why X instead of Y → `decisions`; one project's context → `projects/<name>`.
2. Prefer editing: if `wiki_search` finds the topic, use `wiki_patch_section` (mode `append` for a new pitfall, `replace` to correct a section). Only create when nothing fits.
3. To create: `wiki_template` for the category, fill every section (write `N/A` if one does not apply), then `wiki_upsert` with a `summary` under 200 characters that lets a reader decide without opening the page, 1–3 `tags` from `wiki://tags`, and `[[id]]` links to related pages. Default `confidence` is `draft`.
4. If `wiki_upsert` is refused with `similar`, edit the listed page instead, or pass `force: true` only when the topic is genuinely different.
5. If the result reports `conflicts`, tell the user: a `*.conflict-<host>.md` file needs a manual merge.

All content is English. Writes are linted, committed, and pushed automatically.

## CLI fallback

When MCP tools are not available, the same operations exist as a CLI: `doltap search <q>`, `doltap get <id> [-s Section]`, `doltap template <cat>`, `doltap add <id> --title .. --summary .. --tags a,b --stdin`, `doltap patch <id> -s Section --content ..`, `doltap meta <id> --confidence verified`. Add `--json` for structured output. Set `DOLTAP_AGENT=claude-code` so commits record the client.
