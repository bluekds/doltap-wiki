---
title: Reference
category: reference
summary: Hub for the reference category. What is X — summaries of external facts (APIs, versions, limits).
tags: [wiki]
confidence: verified
created: 2026-10-18
updated: 2026-10-18
sources: []
---

# Reference

What is X — summaries of external facts (APIs, versions, limits). Create new pages from `_meta/templates/reference.md` and add a link to the list below.

## Pages

```dataview
TABLE confidence, tags, summary
FROM "reference"
WHERE file.name != "_index"
SORT file.name ASC
```

## Manual list

For readers without Dataview (agents, other viewers). `doltap add` and `wiki_upsert` append the line automatically; add one by hand only when you create the file without the tools.

- [[reference/obsidian-conventions]] — Obsidian features this wiki relies on and where they are configured
