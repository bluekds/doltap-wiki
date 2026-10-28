# Roadmap to 1.0

Status as of 0.5.0 (2026-10-28): 16 MCP tools, 3 resources, launchd/cron/schtasks scheduling, Claude Code integration, `doctor`/`upgrade`/`history`/`golden` commands, ranked search with a golden regression set, synchronous git, every audit finding covered by a reproduction test.

Versions below are ordering, not dates. Items move between versions when real usage shows a different priority.

## What 1.0 means

1.0 is a promise about stability, not a feature count.

**Frozen at 1.0**
- Interface contract: MCP tool names and arguments, CLI commands and flags, page frontmatter fields and PROTOCOL structure, `.doltap/` file formats (`http-clients.json`, sync state), index schema version.
- Compatibility policy: semver. An interface slated for removal is warned about for at least one minor release first. Index and config files migrate automatically.
- Quality bar: zero HIGH findings in an external security audit, one release cycle of incident-free operation on two or more machines, every tool and flag documented.

**Non-goals, kept on purpose**
- No web UI. Obsidian is the viewer for people.
- No hosted service, no mandatory OAuth, no dependency on any agent framework.

## 0.4 Operability (shipped in 0.4.0)

Everything a person does by hand today during the daily and weekly checks becomes a command. Delivered: `doltap doctor`, `doltap upgrade`, `integrations status`, log rotation, `wiki_history`, the write-latency cap with offline backoff (git stays synchronous; the HTTP server blocks for at most one capped remote call), and the open audit items. The remaining 0.4 bullet, fully asynchronous git in the HTTP server, moves to 0.6 with the session work.

- `doltap doctor`: one command that checks sync, schedule, serve, `/healthz`, lint and conflict copies, with `--json` output. Includes the checks the 0.3.0 audit added: symlinked pages, `tags.yaml` parses, a session id is configured for writers.
- `doltap upgrade`: shows skeleton changes (such as the `.gitattributes` union line or PROTOCOL wording) as a diff against an existing wiki and applies them. This was done by hand twice during 0.2 to 0.3.
- `integrations status`: detects an installed skill copy that is older than the package.
- Log rotation with a size cap.
- `wiki_history` and `doltap history <id>`: per-page git history so an agent can see who changed what and when.
- Asynchronous git behind the write lock, with a write-latency cap: a dead remote is reported as offline within seconds instead of blocking reads and `/healthz`.
- Re-check the audit items left open in 0.3.1: a 0.2.0 process erasing `replaced_by` in a 0.3.0 index when versions are mixed, CRLF `tags.yaml` on older Windows wikis, hub refresh and stats on a detached HEAD, sync summary reporting `pushed: false` after a hub-refresh push, resolving a page the upstream deleted.

## 0.5 Search quality (shipped in 0.5.0)

The wiki is worth what its first result is worth.

- Ranking: bm25 scaled by confidence (verified ×1.1, deprecated ×0.5 and last), recency (≤30 days ×1.05, >1 year ×0.9) and title hits (up to ×1.15). Small on purpose: they settle near-ties, not clear text matches.
- Search log: every search is kept in the per-machine index with the ids returned; `doltap audit` pairs it with the page the same caller opened next and lists the misses. Queries never leave the machine, so the weekly check on the host that serves HTTP sees every remote agent's searches, but not a laptop's local ones.
- Golden set: `doltap golden` runs `wiki/_meta/golden.json`; the tool repository tests a 23-query set against a vault built to trip naive ranking (a routine page that mentions everything, a deprecated twin, an old draft beside a verified page).
- Embedding search, evaluated: a local model (`bge-small` or `nomic-embed-text` through transformers.js or node-llama-cpp) costs a 30–130 MB download, native or WASM inference, and 20–80 ms per page at index time; the golden set shows no query that bm25 with stemming and the OR fallback misses for lexical reasons alone. Deferred until the search misses collected by `doltap audit` show semantic gaps (a query whose words never occur on the right page). When it comes, it is an optional `--embeddings` index next to FTS5, never a replacement.

## 0.6 Clients and access control

- `integrations install` for Codex CLI, Cursor, Gemini CLI, and a generic JSON snippet.
- Client tokens gain an expiry and a call log (which client called which tool).
- HTTP sessions move from "client name plus day" to the MCP session id. The 0.3.1 scheme only stops a client from promoting a page it created the same day.
- Per-category write scope only if a real need appears.
- OAuth 2.1 for the claude.ai connector evaluated as an option. The path token stays the default.

## 0.7 Content lifecycle

- `review_by` field on reference pages with a lint warning, automating the 60-day rule.
- `doltap audit --report` writes the weekly report. Deprecate, merge and delete keep requiring human approval.
- Attachment policy: `wiki/_assets`, size cap, lint.

## 0.8 Scale and multiple wikis

- Tests at five thousand pages: reindex time, search latency. Incremental reindex of changed files only.
- Documented setup for a shared wiki and a personal wiki on one machine, with easy `--root` switching.

## 0.9 Stabilization

- Interface freeze. Tool reference generated from the zod schemas. Migration tooling complete.
- npm publishing through GitHub Actions trusted publishing with provenance, replacing manual publish.
- Every release gets two independent audits (security and core logic) before tagging, and each confirmed finding lands as a reproduction test in the regression suite. 0.3.1 set this precedent with 14 findings, all covered by tests.
- schtasks verified on a real Windows machine. Long-running operation on two or more machines. External security audit.

## 1.0

Declaration that the bar above is met, plus the 1.x compatibility policy.

## Why this order

Operability comes first because every friction point in the first days of real use was operational: manual checks, hand-applied upgrades, stale skill copies, manual publishing. Search quality needs more pages before it can be measured. Access control expansion matters once there are more users.
