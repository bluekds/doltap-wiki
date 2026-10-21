# Changelog

## 0.1.0 (2026-10-21)

First public release.

- Markdown + git wiki with five categories (howto, patterns, reference, decisions, projects), per-category templates, protocol and tag vocabulary; opens as an Obsidian vault
- `doltap` CLI: init (`--new` scaffold or `--repo` clone), search (SQLite FTS5 via `node:sqlite`), get, list, related, add, patch, meta, lint, sync, reindex, audit, schedule, serve, integrations
- `doltap-mcp`: 11 MCP tools and 3 resources over stdio or Streamable HTTP (path-token protected)
- Every write runs pull --rebase, lint, commit, push; conflicts are kept as `<id>.conflict-<host>.md`; offline writes push on the next sync
- Per-machine read statistics and `doltap audit` for stale, unreferenced and lingering-draft pages
- Periodic sync and always-on HTTP service via launchd (macOS), crontab (Linux) or Task Scheduler (Windows)
- `doltap integrations install claude` sets up the skill, global instruction and MCP registration for Claude Code
