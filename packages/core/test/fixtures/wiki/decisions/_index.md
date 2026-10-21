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

For readers without Dataview (agents, other viewers). When you add a page, add one line here too.

- [[decisions/wiki-storage-markdown-git]] — why the wiki is stored as Markdown + git
- [[decisions/wiki-tooling-typescript]] — why the CLI/MCP tooling is written in TypeScript
