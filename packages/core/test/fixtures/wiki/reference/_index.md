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

For readers without Dataview (agents, other viewers). When you add a page, add one line here too.

- [[reference/obsidian-conventions]] — Obsidian features this wiki relies on and where they are configured
