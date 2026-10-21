---
title: Decisions
category: decisions
summary: Hub for the decisions category. Why X instead of Y — records of technical choices (ADR).
tags: [wiki]
confidence: verified
created: 2026-10-18
updated: 2026-10-18
sources: []
---

# Decisions

Why X instead of Y — records of technical choices (ADR). Create new pages from `_meta/templates/decisions.md` and add a link to the list below.

## Pages

```dataview
TABLE confidence, tags, summary
FROM "decisions"
WHERE file.name != "_index"
SORT file.name ASC
```

## Manual list

For readers without Dataview (agents, other viewers). `doltap add` and `wiki_upsert` append the line automatically; add one by hand only when you create the file without the tools.

