# Roadmap to 1.0

Status as of 0.3.1 (2026-10-27): 15 MCP tools, 3 resources, 22 CLI commands, launchd/cron/schtasks scheduling, Claude Code integration, synchronous git, two independent audits of 0.3.0 fixed in 0.3.1 with reproduction tests.

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

## 0.4 Operability

Everything a person does by hand today during the daily and weekly checks becomes a command.

- `doltap doctor`: one command that checks sync, schedule, serve, `/healthz`, lint and conflict copies, with `--json` output. Includes the checks the 0.3.0 audit added: symlinked pages, `tags.yaml` parses, a session id is configured for writers.
- `doltap upgrade`: shows skeleton changes (such as the `.gitattributes` union line or PROTOCOL wording) as a diff against an existing wiki and applies them. This was done by hand twice during 0.2 to 0.3.
- `integrations status`: detects an installed skill copy that is older than the package.
- Log rotation with a size cap.
- `wiki_history` and `doltap history <id>`: per-page git history so an agent can see who changed what and when.
- Asynchronous git behind the write lock, with a write-latency cap: a dead remote is reported as offline within seconds instead of blocking reads and `/healthz`.
- Re-check the audit items left open in 0.3.1: a 0.2.0 process erasing `replaced_by` in a 0.3.0 index when versions are mixed, CRLF `tags.yaml` on older Windows wikis, hub refresh and stats on a detached HEAD, sync summary reporting `pushed: false` after a hub-refresh push, resolving a page the upstream deleted.

## 0.5 Search quality

The wiki is worth what its first result is worth.

- Ranking: weight title and summary matches, `verified` pages, and recent updates.
- Record search queries in stats so the weekly check can list queries whose expected page was not first.
- A golden query set as a regression test.
- Embedding search is evaluated only as an optional, local-model feature.

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
