# Changelog

## Unreleased

- Projects are directories: `projects/<name>/_index` is the overview (template sections required) and `projects/<name>/<topic>` pages are free-form; new pages are listed in the nearest `_index` (topic pages in the project hub, project hubs in `projects/_index`); project hubs now appear in `list`, `audit` and the generated index
- The projects template no longer contains placeholder wikilinks, which made `doltap add projects/<id>` without a body fail lint
- `doltap --version` reads the version from package.json instead of a hardcoded string (0.1.1 reports 0.1.0)

## 0.1.1 (2026-10-22)

- Scheduler entries (launchd, crontab) now run the JS entry through the absolute Node binary, so Node installed via nvm works for the periodic sync and the HTTP service
- `doltap init --new` no longer persists the placeholder git identity; it only signs the initial commit with it and tells you to set a real one
- `doltap integrations install claude` prints the wiki root it will register and, in `--dry-run`, the implicit removal of an existing registration
- Search snippets mark matches with `**` instead of `[ ]`, which collided with wikilinks and paths
- `docs/SETUP-FOR-AGENTS.md`: setup instructions an agent can follow end to end (rehearsed)

## 0.1.0 (2026-10-21)

First public release.

- Markdown + git wiki with five categories (howto, patterns, reference, decisions, projects), per-category templates, protocol and tag vocabulary; opens as an Obsidian vault
- `doltap` CLI: init (`--new` scaffold or `--repo` clone), search (SQLite FTS5 via `node:sqlite`), get, list, related, add, patch, meta, lint, sync, reindex, audit, schedule, serve, integrations
- `doltap-mcp`: 11 MCP tools and 3 resources over stdio or Streamable HTTP (path-token protected)
- Every write runs pull --rebase, lint, commit, push; conflicts are kept as `<id>.conflict-<host>.md`; offline writes push on the next sync
- Per-machine read statistics and `doltap audit` for stale, unreferenced and lingering-draft pages
- Periodic sync and always-on HTTP service via launchd (macOS), crontab (Linux) or Task Scheduler (Windows)
- `doltap integrations install claude` sets up the skill, global instruction and MCP registration for Claude Code
