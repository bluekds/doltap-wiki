---
title: Obsidian conventions and how this wiki applies them
category: reference
summary: >-
  Obsidian features this wiki depends on — wikilinks, backlinks, frontmatter
  properties, Dataview, obsidian-git — and where each is configured.
tags:
  - obsidian
  - wiki
confidence: draft
created: 2026-10-18
updated: 2026-10-19
sources:
  - 'https://help.obsidian.md/links'
  - 'https://help.obsidian.md/properties'
  - 'https://blacksmithgu.github.io/obsidian-dataview/'
  - >-
    Obsidian 1.14.4 on a macOS host, 2026-10-19: vault opened, Dataview
    dashboard and graph confirmed by user
---
## Key facts

| Feature | Use in this wiki | Config / location |
|---|---|---|
| Wikilink `[[path/to/page]]` | The only way pages link. Path-based (`newLinkFormat: absolute`) to avoid same-name collisions | `.obsidian/app.json` |
| Section link `[[page#Heading]]` | Reference a specific section. Maps to the agent call `wiki_get(id, section)` | — |
| Backlinks | Bottom panel + Dataview `file.inlinks`. Used for orphan detection | core plugin `backlink` |
| Graph view | Inspect knowledge structure. Hubs (`_index`) should be the centers | core plugin `graph` |
| Properties (frontmatter) | `confidence`, `tags`, `summary` editable and filterable in the UI | core plugin `properties` |
| Dataview | Auto lists on hub pages, status dashboard on Home | community plugin, install on first launch |
| obsidian-git | Auto pull/commit/push for human edits (10 min interval, rebase) | community plugin, `basePath: ".."` |
| Templates | `_meta/templates/` folder, `{{date}}` substitution | core plugin `templates` |

## Details

- The vault root is `wiki/`, not the repository root. If `packages/node_modules` entered the vault, indexing would slow down and the graph would be polluted.
- `_meta/templates/` is excluded via `userIgnoreFilters` so that the `[[howto/_index]]` links inside templates do not count as backlinks.
- Community plugin binaries are not committed. `community-plugins.json` lists them and only their settings (`plugins/*/data.json`) are committed. On a new machine Obsidian shows a "plugin not installed" warning; install both from Settings > Community plugins.
- Dataview query blocks are plain text to agents. That is why hub pages keep a separate "Manual list" section readable by agents and other viewers.

## Verified on

2026-10-18. Written before Obsidian was installed on the authoring machine, so check app.json key names on first launch.

## Related

- [[reference/_index]]
