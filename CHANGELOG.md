# Changelog

## 0.9.1 (unreleased)

Follow-up to the 0.9.0 audits: the medium and low findings (core M1–M10, M12, L1–L14; security S9–S14), each with a regression test.

- **A write that fails before its commit leaves a clean tree** (audit M1). When the commit itself failed (a hook, `index.lock` held by another process, no git identity), the page stayed on disk and staged: the retry was refused as "exists" and the next unrelated write swept the file into its own commit, attributing the page to the wrong session. Every writer now restores the previous bytes (or removes a new file), takes regenerated hubs back to HEAD and unstages, then rethrows. A page commit also takes only the paths of that write, so whatever else is staged stays staged
- **`doltap init --new` refuses a non-empty directory** (audit M10). It used to replace the directory's `.gitignore`, rename every `dot.*` file in it and commit everything, including an `.env`. It now stops unless `--force` is given; with `--force` the existing `.gitignore` / `.gitattributes` keep their lines and gain the skeleton's, only copied files are renamed and only the skeleton is committed
- **The lint gate blocks only errors the write introduces** (audit M6). A link broken by a hand commit, a tag removed from `tags.yaml` or a template that grew a required section used to freeze the page: verify, deprecate and every edit were refused with the old error. Such errors are still reported in `issues`, but only a new error refuses the write
- **Rewriting a page keeps its confidence** (audit M5). `wiki_upsert` with `replace` demoted a verified page to draft while keeping `verified_on`, revived a deprecated page (back into default search with `replaced_by` still set), and the rewriting session could then verify its own text. A rewrite now keeps the confidence, a deprecated page is refused ("edit the replacement or create a new page"), an explicit demotion clears `verified_by` / `verified_on`, and the session of every `wiki: rewrite` commit counts as an author for the self-promotion guard. `wiki_set_meta` / `doltap meta` refuse `confidence: deprecated` (use deprecate, which records the replacement) (L6)
- **Every git operation runs under the machine write lock** (audit M2). A read's auto-pull used to `pull --rebase --autostash` while another process was mid-write (index.lock failures, the M1 stranding), the stats commit went through a held lock, and `wiki_sync` regenerated hubs with the synchronous lock, blocking the HTTP event loop for up to 30 s. Auto-pull now takes the lock only if it is free and otherwise skips ("auto-pull skipped: another doltap write is in progress"); the stats commit and the whole of `wiki_sync` / `doltap sync` run under one lock, and the server's wait yields to the event loop with the configured timeout
- **Conflicts on generated files leave no copy** (audit M8, M9). Two machines adding pages to one category used to commit and push `<category>/_index.conflict-<host>.md`, and two hosts running `audit --report` on the same day left a `_meta/reports/<date>.conflict-<host>.md` that no resolve tool accepted. Hub pages and reports now take upstream on a conflict; the hub list is regenerated from the pages right after
- An async lock waiter queued behind a long writer gives up at its own deadline instead of running the write the client already abandoned (L9); `sync.json` is replaced through a temp file and rename (L12); a page deleted between the directory walk and its stat (a pull in another process) is dropped from the index instead of failing the search (L3); FTS rows share the page's rowid so re-indexing no longer scans the whole FTS table per page, and SQLite waits 15 s instead of 5 s for a busy index (L13; index rebuilt once on first use); stats, report and asset commits build their trailers with the same sanitiser as page commits (L14)
- `wiki_upsert` accepts `projects/<slug>/_index` for a project overview, as PROTOCOL section 3 describes (M12); `wiki_set_meta` on a hub whose list was regenerated in the same write returns the on-disk rev (L8); `doltap patch`, `meta`, `verify`, `deprecate` and `resolve` exit 2 on a refusal with `--json` too (L5)

## 0.9.0 (2026-11-04)

Stabilization: two independent audits before tagging (security: 14 findings, core logic: 34), the critical and high items fixed here with regression tests, the rest tracked for 0.9.1. Plus the per-request reindex and a generated tool reference. No index schema change.

- **A conflicted attachment keeps both versions, byte for byte** (audit C1 critical). When two machines added the same file under `wiki/_assets` with different bytes, sync rewrote the binary as UTF-8 text (a 4 KB PNG became 7 KB of garbage on both clones) or, above git's 1 MiB stdout buffer, deleted it on both, while reporting "conflicts: []". Index stages are now read as bytes with a large buffer, and anything under `wiki/` keeps the local version as `<name>.conflict-<host><ext>` (`x.conflict-laptop.png`), listed by sync, audit and doctor
- **Conflict copies are never overwritten** (audit H4). A second conflict on the same page from the same host used to replace the first copy, losing an unpushed hand edit; copies are now numbered (`<id>.conflict-<host>-2.md`)
- **A duplicated hub list no longer breaks every write** (audit H1, L4). A second `## Manual list` in a hub (which a section patch could add) made every page creation, metadata edit and deprecation throw and left the new page untracked. Hub regeneration now collapses duplicates; `wiki_patch_section` / `doltap patch` refuse content that carries a heading at the section's level or above (sub-headings are fine); lint warns `section-duplicate` on any page with two level-2 headings of one name
- **The secret filter covers attachments, tag descriptions and reports** (audit H3 high, S8, S5/M4). `doltap assets add` refused nothing: a `creds.txt` with a token was committed and pushed and only a later lint noticed. Text attachments are now scanned before they are copied (no `--force`), `wiki_add_tag` descriptions are scanned, and an audit report is scanned before it is committed. The committed report no longer carries search query text (a query can hold a pasted secret or text meant to steer the maintenance agent, and the file is pushed to every clone); `doltap audit` still prints the queries on the host that made them
- **The connector URL is masked in every CLI error** (audit S7). A failing `claude mcp add` printed its whole command line, token included; every error message now passes through the mask, which also covers a bare `/<64 hex>` path and upper-case hex. Codex, Cursor and Gemini config files written with `--remote` are created mode 0600
- **Page parsing is linear; inputs are capped** (audit S4 high, S6). The heading regex went cubic on a long line of spaces (a 3 KB heading in one `wiki_patch_section` took 11 s and stalled the HTTP server for every client; 10 KB took minutes), and the wikilink, markdown-link, fence and credential-assignment patterns were quadratic on crafted input. Headings, fences and links are now parsed with linear patterns and string operations (fences also follow CommonMark: up to three spaces of indent, closed only by the same character at least as long; `## Using C#` keeps its `#`), a page over 1,000,000 characters is refused by the parser, tool inputs carry caps (`query` 500, `body`/`content` 256,000, titles and section names 200, evidence and sources 2,000 characters; see docs/TOOLS.md), and a search query keeps at most 32 terms. Asset links inside code spans or fences are examples, not attachments
- **`.doltap/` files that git tracks are never trusted** (audit S2 high, M11). A collaborator could `git add -f` a client list, token file or lock under the gitignored state dir and push it; every clone checked it out, the running HTTP server hot-reloaded the planted client list and accepted its token with full access, and a planted lock naming pid 1 refused every write for good. Now the HTTP server ignores a client list that git tracks, that is a symlink, or whose tokens are not 64 hex (stderr says why), and refuses to start on a tracked or symlinked token file; `doltap sync` prints a WARNING naming tracked state files and the `git rm --cached` fix; `doltap doctor` has a `state` check that fails on them. The write lock treats a dead owner (or pid 1) as stale at once instead of after two minutes, and replaces a symlink in its place
- **No symlink under the root is followed, for reading or writing** (audit S1 critical, S3, H2). Every file doltap touches now resolves through `safePath`, which lstats each path component below the root: pages, templates, PROTOCOL, tags.yaml, reports, stats, attachments, index.md. A collaborator who pushed `wiki/_meta/index.md` as a symlink to `~/.zshrc` used to get that file overwritten with index lines (and a page summary containing a newline put a shell command on its own line) on the victim's next `doltap sync`; a template symlinked to `.doltap/http-token` handed the full-access token to any read-only client; a symlinked page path let `wiki_upsert` write outside the wiki. Now index.md is recreated as a regular file, every other read or write refuses with "is a symbolic link", a planted stats file of another host is skipped by audit, and lint's `symlink` rule reports every link in the tree (previously only page files)
- **Tool reference generated from the server.** `doltap-mcp --reference` connects to the server in memory, lists tools and resources, and renders the JSON schemas the SDK derives from the zod input schemas as markdown; `npm run reference` writes docs/TOOLS.md and `npm run reference:check` (CI, the publish script, and a test) fails when the committed file no longer matches the code. Read tools now carry the MCP `readOnlyHint` annotation, which the reference shows as a Writes column and clients can use to decide what needs confirmation
- **A read no longer parses the whole wiki.** The incremental reindex that runs before every search, get and list used to read and parse every page and only then compare mtime and size with the index; now it stats the files and parses only the ones that changed. At five thousand pages the per-request cost drops from about 400 ms to about 60 ms (docs/BENCH.md). Lint and the asset listing, which need every page, ask for them explicitly (`reindex(false, { pages: true })`); a page whose frontmatter no longer parses is still reported, on every call, until it is fixed

## 0.8.0 (2026-11-03)

Scale, reports, attachments. No index schema change.

- **`doltap audit --report` / `wiki_audit report=true`.** Writes the audit as markdown to `wiki/_meta/reports/<date>.md` and commits it like a stats file (newest 12 kept, `--keep <n>`), so the weekly pass can compare with last week's. Reports are not pages: index, search and lint skip `_meta`. Deprecate, merge and delete still need a human decision
- **Writes no longer stall the HTTP server while waiting for the lock.** MCP write tools (`wiki_upsert`, `wiki_patch_section`, `wiki_set_meta`, `wiki_verify`, `wiki_deprecate`, `wiki_resolve_conflict`, `wiki_add_tag`, `wiki_sync`) now wait for the machine's write lock with `withWriteLockAsync`, which yields to the event loop instead of `Atomics.wait`; other clients' searches and reads answer meanwhile. Queued writes in one process run in arrival order; the timeout and its message are unchanged (30 s, configurable per server with `lockTimeoutMs`). The CLI keeps the synchronous lock
- **A key split across two lines is caught.** The secret filter also scans the page with line breaks between token characters removed, so a credential wrapped by an editor or a narrow terminal is reported as `secret (…, split across lines)`. Wrapped prose, lists and hyphenated line ends do not trigger it; placeholders stay exempt
- **Attachment policy.** Files a page needs live in `wiki/_assets/<page id>/<file>` and are linked with a relative markdown link; `doltap assets add <id> <file>` copies, commits and prints the link, `doltap assets` lists them with the pages that link each. Lint: `asset-missing` (error), `asset-orphan`, `asset-too-large` (2 MB), `asset-type` (warnings); text attachments are scanned for secrets like pages. Attachments are not pages: index and search skip `_assets`
- **Two wikis on one machine.** `doltap integrations install claude --name <server>` registers a second root under another MCP server name (`doltap-team`); `integrations uninstall claude --name <server>` removes only that registration. READMEs explain `--root` / `DOLTAP_ROOT` switching
- **Scale check at five thousand pages.** `DOLTAP_BENCH=1 npx vitest run test/bench.test.ts` (packages/core) generates 5,000 pages and reports full reindex, no-op and incremental reindex, search latency and lint time; numbers in docs/BENCH.md

## 0.7.1 (2026-11-02)

Secret filter fixes from the MCP/security review.

- **More formats caught.** Tailscale auth keys (`tskey-…`), Slack webhook URLs, Azure `AccountKey=…`, the Doltap connector URL with an uppercase token, the bare 64-hex path token after a slash, and unquoted credential assignments of 10 or more characters that mix letters and digits (was 16)
- **Fewer false positives.** A match that is documentation is ignored: the AWS docs key `AKIA…EXAMPLE`, `YOUR_TOKEN_HERE`, `xxxx` fillers, `<angle placeholders>`, ellipses; and an `sk-` match without a digit (`sk-learn-…` prose) is not a key. One such string no longer blocks every later patch to its page
- **Atomic token creation.** Two HTTP server processes starting together on one root now share one token; the second reads the first one's file instead of writing its own
- **An explicit root must be a wiki.** `--root` or `DOLTAP_ROOT` pointing at a directory without `wiki/` is now an error instead of a silent fallback to `~/.doltap` (a throwaway directory could otherwise land writes, tokens or test data in the real wiki; found the hard way by a test in this release)
- Not changed: a key split across two lines still passes; a write waiting for the lock still blocks the HTTP server for up to 30 s (0.8)

## 0.7.0 (2026-11-02)

Content lifecycle: validity follows what a page depends on, not the calendar.

- **`review_by`.** Optional frontmatter date on `howto/` and `reference/` pages (`doltap add|meta --review-by <days|date|none>`, `review_by` on `wiki_upsert` / `wiki_set_meta`), set by the author from the page's volatility. Lint warns (`review-due`) once it passes; `wiki_get` returns `review_due: true`. The howto and reference templates carry the placeholder
- **Re-verification.** `wiki_verify` / `doltap verify` on a page that is already verified records a re-check instead of refusing: `verified_on`, `verified_by` and `review_by` move forward (an explicit `--review-by`, else the previous interval), the evidence is appended, the body and `updated` stay. Commit action `re-verify`
- **Audit.** `stale` is gone; `unreviewed` lists volatile pages whose `review_by` passed or, without one, with no re-check within the category window (reference 180 days, howto 365; `--review-days` overrides). `unreferenced` is a discoverability check, not a deprecation list. `decisions/` and `projects/` never appear in an age-based list. JSON entries carry `category`, `reviewBy`, `verifiedOn`
- **Ranking.** The recency factor is now a ×1.05 lift for pages created or verified in the last 30 days (keyed on `verified_on`); the ×0.95 / ×0.9 penalties for age are removed; decisions and projects get no recency effect. A correct page that nobody needed to edit no longer sinks below a churned one
- Index schema 3 (rebuilt automatically); PROTOCOL gains a "Lifecycle" section (`doltap upgrade --diff` shows it)
- Breaking for scripts: `doltap audit --stale-days` → `--review-days`, `wiki_audit.stale_days` → `review_days`, report field `stale` → `unreviewed`

## 0.6.0 (2026-10-29)

Clients and access control.

- **More agent clients.** `doltap integrations install codex|cursor|gemini` writes the `doltap` server into the client's user-level config (`~/.codex/config.toml`, `~/.cursor/mcp.json`, `~/.gemini/settings.json`), stdio with the clone or `--remote <url>` for the always-on endpoint, and appends the Doltap section to `~/.codex/AGENTS.md` / `~/.gemini/GEMINI.md` (Cursor gets the text to paste into User Rules). `install generic` prints the JSON for any other MCP client. `integrations status` and `doctor` report every client; `uninstall <client>` removes the entry
- **MCP sessions over HTTP.** A client that initializes gets an `Mcp-Session-Id` and keeps one server for the conversation; its writes carry `[session:<client>/<id>]`, so "the session that created a page cannot verify it" now means that conversation, not the whole day. Requests without a session id are still served statelessly with `<client>@<day>`. Idle sessions close after 2 hours
- **Client token expiry.** `doltap serve client add <name> --expires <days|date>`, `client extend <name> --expires …|never`; `client list` shows the days left; an expired token answers 404; `doctor` warns a week ahead
- **Call log.** The HTTP server appends one line per request to `.doltap/logs/http-calls.log` (time, client, method, tool, status, duration; never arguments or tokens; rotated with the other logs). `doltap serve calls [--since 7] [-n 20]` summarises per client and tool
- **Background push in the HTTP server.** A write returns as soon as its commit is made; the push runs as a child process a moment later (`DOLTAP_DEFER_PUSH=0` restores synchronous pushes). A rejected push pulls and retries; a commit made during a push is pushed by the next pass. The scheduler's sync still covers a server that died before pushing
- Per-category write scope and OAuth 2.1 were evaluated and left out (see docs/ROADMAP.md)

## 0.5.0 (2026-10-28)

Search quality: the first result is what the wiki is worth.

- **Ranking beyond bm25.** The FTS5 score is scaled by small multipliers: verified ×1.1 (deprecated ×0.5 and always last), updated within 30 days ×1.05 / older than a year ×0.9, and up to ×1.15 when the query terms appear in the title. The multipliers decide near-ties and never override a clear text match. `score`, `bm25` and `boost` are returned per hit
- **Search log and misses.** Every search is recorded in the per-machine index (query, caller, ids returned; pruned after 180 days; never committed). `doltap audit` pairs each search with the page the same caller opened within 15 minutes and lists the queries whose answer was not the first hit ("search misses"), with the rank it had
- **Golden query set.** `doltap golden [file]` runs `wiki/_meta/golden.json` (`[{query, expect, note?}]`) and exits 1 when a query's page is not first. The tool repository keeps its own 23-query set under test as a regression suite for ranking changes
- Embedding search was evaluated and deferred (see docs/ROADMAP.md)

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
