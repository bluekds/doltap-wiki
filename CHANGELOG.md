# Changelog

## 0.4.1 (2026-10-28)

- **Fix: a `##` section now includes its `###` sub-sections.** `wiki_get` / `doltap get -s <heading>` returned an empty string for a section whose body started with a sub-heading, and `wiki_patch_section` only replaced the text before the first sub-heading. A section runs until the next heading at its own level or higher; a `###` heading can still be read and patched on its own

## 0.4.0 (2026-10-28)

Operability: the checks the maintenance routine did by hand are commands now.

- **`doltap doctor`**: one read-only run of every health check with `--json` and exit 1 on failures: git state (branch, identity, unpushed commits, uncommitted pages, conflict copies), scheduler and HTTP service (with a `/healthz` probe; `--healthz <url>` probes the public endpoint too), pull age against the scheduled interval, `tags.yaml`, lint, index consistency, session trailers on recent writes, token file modes and client names, shipped config drift, log sizes and `sync.err`, Node line, and the Claude Code integration (skill copy, instruction section, MCP registration). `--no-services` and `--quiet` for scripts
- **`doltap upgrade`**: compares the wiki with the skeleton shipped in the installed version. `--apply` appends missing `.gitignore` / `.gitattributes` lines (the `merge=union` rule for old wikis) and replaces Obsidian config and page templates in one commit; `PROTOCOL.md` and `tags.yaml` differences are shown with `--diff` for a manual merge; example pages are never touched
- **`wiki_history` / `doltap history <id>`**: the commits that changed a page, newest first, with action, host, agent, session and note (verify evidence, deprecate reason)
- **`doltap integrations status`**: whether the installed skill, instruction section and MCP registration match this version
- **Write latency cap.** One pull or push never waits longer than `DOLTAP_REMOTE_TIMEOUT_MS` (default 15 s). After the remote is found unreachable, writes skip the push for `DOLTAP_AUTO_PULL_MINUTES` and report `push deferred`; `doltap sync` (the scheduler) always retries, and any successful pull or push clears the backoff
- Logs in `.doltap/logs/` are rotated by `sync` once they pass 1 MB (copy-truncate, three generations kept); `serve status` reports host, port and pid
- Fixes for audit items left unverified in 0.3.1: `resolve --take conflict` restores a page the upstream deleted from its conflict copy; hub refresh and stats publishing refuse a detached HEAD; `sync` reports `pushed: true` when the hub refresh commit is what got pushed; a CRLF `tags.yaml` is rewritten as LF without duplicating groups

## 0.3.1 (2026-10-27)

Fixes from the 0.3.0 independent audits (security and core).

- **Security: symlinked page files are no longer read.** A `wiki/<category>/<slug>.md` that is a symbolic link (planted through the shared git remote) used to be returned by `wiki_get` and indexed by search, which exposed any file on the service host, including `.doltap/http-token`, to read-only token holders. Reads and the index skip symlinks; `lint` reports them as `symlink` errors
- **`wiki_verify` self-promotion guard now works by default.** Nothing set a session id before, so the "session that created the page cannot verify it" rule never fired. The stdio MCP server now gets a session id per process, the HTTP server one per client and day, and the CLI takes `CLAUDE_CODE_SESSION_ID` when `DOLTAP_SESSION` is unset. `wiki_upsert`, `wiki_set_meta`, `doltap add` and `doltap meta` refuse `confidence: verified`; only verify promotes
- **tags.yaml can no longer be broken by `wiki_add_tag`.** Descriptions are YAML-quoted (a leading backtick, `@`, `[`, quote or `*` used to make the file unparsable on every clone), group headers with trailing comments are recognised, the result is re-parsed before it is written, and duplicate keys left by a `merge=union` of the same tag added on two machines are tolerated and cleaned up on the next edit. `tags remove` works with any indentation and refuses when the tag survived
- Git: a pull or push killed by its timeout is classified as `offline` (the write stops retrying instead of blocking for minutes); `[remote rejected]`, hook and protected-branch refusals are `remoteError`; the write lock is only treated as stale when its owner process is gone, so a long push cannot have its lock stolen
- `wiki_resolve_conflict` / `doltap resolve`: accepts `base_rev`, handles a conflict copy that was never committed (left by an autostash conflict), and refuses `take: conflict` when more than one copy exists instead of silently dropping one
- The `rev` returned by a write is the on-disk rev when the written page is itself a hub whose list was regenerated
- Lint warns (`replaced-by-deprecated`) when `replaced_by` points at a page that is deprecated itself
- Commit trailers (`[host:]`, `[agent:]`, `[session:]`) are sanitised; HTTP client names must be kebab-case or the client is ignored

## 0.3.0 (2026-10-27)

- **`wiki_deprecate` / `doltap deprecate`**: sets `confidence: deprecated` and `replaced_by`, adds a banner at the top of the body, updates the hub. The replacement must exist. Lint now fails a deprecated page without a replacement; search and get return `replaced_by`
- **`wiki_verify` / `doltap verify`**: promotion needs evidence (appended to `sources`), records `verified_by` and `verified_on`, and refuses the session that created the page. `wiki_set_meta` and `wiki_upsert` no longer accept `verified`
- **`wiki_resolve_conflict` / `doltap resolve`**: write the merged body (or keep the conflict copy with `take: conflict`), delete the `*.conflict-<host>.md` copies and commit. `wiki_get` lists `conflict_copies`
- **Tags**: `wiki_add_tag` / `doltap tags add|remove` edit `_meta/tags.yaml` (comments and groups kept); `tag-unknown` suggests the closest tag; `audit` reports unused tags; `tags.yaml` merges with `merge=union` so concurrent additions never conflict (add the line to `.gitattributes` of existing wikis)
- **Named HTTP client tokens**: `doltap serve client add <name> [--read-only]` issues a token whose commits carry `[agent:<name>]`; read-only tokens get an error from every write tool. Stored in `.doltap/http-clients.json` (0600), picked up without restarting the service
- Writes refuse a detached HEAD instead of orphaning the commit
- Sync reports distinguish `offline` (network) from `remoteError` (authentication, permissions, wrong URL, missing repository), so a revoked token no longer looks like a flaky network

## 0.2.0 (2026-10-27)

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
