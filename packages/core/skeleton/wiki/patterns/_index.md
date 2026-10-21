---
title: Patterns
category: patterns
summary: Hub for the patterns category. How do I implement X — code patterns reused across projects.
tags: [wiki]
confidence: verified
created: 2026-10-18
updated: 2026-10-18
sources: []
---

# Patterns

How do I implement X — code patterns reused across projects. Create new pages from `_meta/templates/patterns.md` and add a link to the list below.

## Pages

```dataview
TABLE confidence, tags, summary
FROM "patterns"
WHERE file.name != "_index"
SORT file.name ASC
```

## Manual list

For readers without Dataview (agents, other viewers). `doltap add` and `wiki_upsert` append the line automatically; add one by hand only when you create the file without the tools.

