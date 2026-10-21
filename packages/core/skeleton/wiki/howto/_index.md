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

For readers without Dataview (agents, other viewers). `doltap add` and `wiki_upsert` append the line automatically; add one by hand only when you create the file without the tools.

- [[howto/add-wiki-page-manually]] — add a page by copying a template when the CLI is unavailable
- [[howto/setup-wiki-on-new-machine]] — install the CLI, clone the wiki, register the MCP server and skill, install the periodic sync (once per machine)
- [[howto/maintain-doltap-wiki]] — session-start, weekly, monthly and event-driven checks for a maintainer agent, with prompts for a scheduled session
