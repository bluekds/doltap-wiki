---
title: Projects
category: projects
summary: Hub for the projects category. Per-project context — environment, pages used, project-only notes.
tags: [wiki]
confidence: verified
created: 2026-10-18
updated: 2026-10-18
sources: []
---

# Projects

Per-project context — environment, pages used, project-only notes. Create new pages from `_meta/templates/projects.md` and add a link to the list below.

## Pages

```dataview
TABLE confidence, tags, summary
FROM "projects"
WHERE file.name != "_index"
SORT file.name ASC
```

## Manual list

For readers without Dataview (agents, other viewers). `doltap add` and `wiki_upsert` append the line automatically; add one by hand only when you create the file without the tools.

