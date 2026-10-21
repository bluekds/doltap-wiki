---
title: Add a wiki page manually without the CLI
category: howto
summary: Create a page by copying a template and committing by hand when the wiki CLI/MCP is unavailable. Reproduces what the CLI does.
tags: [wiki, git]
confidence: draft
created: 2026-10-18
updated: 2026-10-18
sources: []
---

## Prerequisites

- The repository is cloned and you have push access
- You have chosen the category using the classification table in [[_meta/PROTOCOL]]

## Steps

1. Sync first: `git pull --rebase`
2. Copy the template: `cp wiki/_meta/templates/<category>.md wiki/<category>/<slug>.md`
3. Fill in the frontmatter. Replace `{{date}}` with today's date, make `category` match the directory, and use only tags listed in `_meta/tags.yaml`
4. Fill in the body sections. Do not delete a section that does not apply; write "N/A"
5. Add `- [[<category>/<slug>]] — one-line summary` to the "Manual list" section of `wiki/<category>/_index.md`
6. Commit and push:

   ```sh
   git add wiki/
   git commit -m "wiki: add <category>/<slug>" -m "[host:$(hostname -s)] [agent:manual]"
   git push
   ```

7. If the push is rejected, run `git pull --rebase` and push again

## Verification

- `grep -L "^summary:" wiki/<category>/<slug>.md` prints nothing (summary is present)
- With Obsidian, the graph view shows the new page connected to its `_index`
- Inspect `git diff --cached` to confirm no secrets were included

## Pitfalls

- If the `category` field and the directory differ, lint will reject the page later
- Spaces or uppercase in the filename produce awkward ids. Use kebab-case only
- Forgetting the `_index.md` manual list hides the page from agents that lack Dataview (search still finds it)

## Related

- [[howto/_index]]
- [[_meta/PROTOCOL]]
