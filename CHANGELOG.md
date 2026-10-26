# Changelog

## Unreleased

- **Optimistic concurrency.** Every page read carries a `rev` (`wiki_get`, `doltap get`). `wiki_upsert`, `wiki_patch_section` and `wiki_set_meta` (CLI `--base-rev`) refuse a write as `stale` when the page changed since that rev, instead of silently overwriting another machine's edit
- **`wiki_upsert` no longer replaces an existing page by accident.** An existing id is refused unless `replace: true` (CLI `--replace`); edits go through patch/set_meta
- **Search falls back gracefully.** Stopwords are dropped, non-ASCII words are kept, every-term matches come first, and when they are scarce pages matching at least half of the terms follow, ranked by how many they contain (`matched` in the result). Category hubs are excluded unless `include_hubs`; the tag filter is applied in SQL so filtered searches no longer miss hits
- **One malformed page no longer breaks every command.** Reindex skips it and reports it (`frontmatter-invalid` in lint, `broken_pages` in sync). A UTF-8 BOM is tolerated, and frontmatter is read with the failsafe YAML schema so `title: 1.10` is no longer rewritten as `1.1` by the next patch
- **Hub "Manual list" sections are generated** from the index on every write and sync (sorted by id, deprecated pages marked, summary changes reflected). Hand edits are overwritten; the hub intro text is kept
- **`wiki_patch_section` targets the `##` heading** even when a `###` with the same name comes first, leaves blank lines elsewhere in the page (code blocks) untouched, keeps leading indentation, refuses an unknown heading with the list of existing ones unless `create: true` (CLI `--create`), and errors on ambiguous headings
- The MCP server sends `instructions` (search first, confidence semantics, edit by section with base_rev, no secrets, English), so claude.ai connectors that never read `wiki://protocol` still get the rules
- Skeleton protocol and hubs describe the generated lists and the replace/base_rev rules

## 0.1.2 (2026-10-26)

Security fixes for the remote endpoint; update and re-run `doltap serve install` (and `doltap schedule install`).

- **Page ids are validated before any file access** (`PAGE_ID_RE`: `/`-separated segments of letters, digits, `-`, `_`). Previously an id such as `howto/../../x` could read or write files outside `wiki/`, through the CLI and every MCP tool. MCP schemas now reject such ids up front as well
- **Writes are serialized** with a lock file in `.doltap/` (CLI, MCP server and scheduler on the same clone wait for each other) and SQLite opens with a busy timeout. Concurrent writers used to fail with "database is locked", drop hub entries and interleave commits
- **The HTTP server** caps request bodies at 2 MiB (413), accepts only loopback, the bind host and `*.ts.net` as `Host` (421; extend with `DOLTAP_HTTP_ALLOWED_HOSTS`), compares the path token in constant time, and returns generic error messages (details go to the service log)
- **The CLI no longer prints the HTTP token**: `serve install` shows `<token>` unless `--show-url`; `serve token --rotate --quiet` rotates silently; `integrations install claude --remote` masks the URL in its output and reads it from `DOLTAP_REMOTE_URL` when the value is omitted; the token file is chmod 600 on every write and created before the service is installed
- `DOLTAP_NO_SYNC=1` is honoured by the CLI again (it was overridden by the default of `--no-sync`, so "local only" writes were pushed)
- Lint catches more secret formats: Doltap's own connector URL (`/<64 hex>/mcp`), `github_pat_`, Google `AIza`, GitLab `glpat-`, Stripe `sk_live_`, `npm_`, `hf_`, `Authorization: Bearer …`, and unquoted `KEY=value` assignments; `sk-ant-` keys are reported as anthropic-key
- A failed auto-pull is not retried on every read any more; reads back off for `DOLTAP_AUTO_PULL_MINUTES` after an attempt, and git error messages mask `user:password@` in remote URLs
- launchd entries use a stable Node path when one resolves to the running binary (`/opt/homebrew/opt/node@<major>/bin/node` instead of the Cellar path that `brew upgrade` removes), XML-escape every value, and the HTTP service gets a `ThrottleInterval`; crontab lines quote their paths
- Skeleton `PROTOCOL.md`: the classification table lists every required section (`Used in`, `Details`), and the secrets rule now says to record where a secret lives and how to load it, matching the skill and the MCP tool descriptions
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
