---
title: How-to
category: howto
summary: Hub for the howto category. How do I do X — reproducible procedures.
tags:
  - wiki
confidence: verified
created: 2026-10-18
updated: 2026-10-18
sources: []
---
# How-to

How do I do X — reproducible procedures. Create new pages from `_meta/templates/howto.md` and add a link to the list below.

## Pages

```dataview
TABLE confidence, tags, summary
FROM "howto"
WHERE file.name != "_index"
SORT file.name ASC
```

## Manual list

For readers without Dataview (agents, other viewers). When you add a page, add one line here too.

- [[howto/add-wiki-page-manually]] — add a page by copying a template when the CLI is unavailable
- [[howto/setup-wiki-on-new-machine]] — Clone the wiki repo, build the CLI, link the wiki command, and verify sync. Required once per machine that runs agents.
