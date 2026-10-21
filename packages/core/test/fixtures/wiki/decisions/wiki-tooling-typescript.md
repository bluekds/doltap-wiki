---
title: Implement the wiki CLI and MCP server in TypeScript
category: decisions
summary: >-
  TypeScript (Node 20+) was chosen so the CLI, MCP server, and optional web UI
  share one codebase. Comparison with Python and Go.
tags:
  - wiki
  - typescript
  - mcp
  - cli
confidence: verified
created: 2026-10-18
updated: 2026-10-18
sources:
  - 'Doltap design session, 2026-10-18'
  - 'node:sqlite FTS5 check on a macOS host, 2026-10-18 (Phase 2 implementation)'
---
## Context

The wiki tooling needs (1) a CLI, (2) an MCP server, and (3) later a read-only web UI. It is deployed to several machines, all of which already have Claude Code installed.

## Options

| Option | Pros | Cons |
|---|---|---|
| TypeScript | Most mature MCP SDK, one codebase for CLI/MCP/web, Node already present on Claude Code machines | Needs a native sqlite module (better-sqlite3) or depends on `node:sqlite` |
| Python (uv) | Fast to build, FastMCP | Separate web UI, per-machine Python environment management |
| Go | Single-binary distribution | Less mature MCP SDK, FTS5-enabled sqlite build is awkward |

## Decision

TypeScript with npm workspaces: `core` / `cli` / `mcp` / `web`. SQLite via the built-in `node:sqlite` module (FTS5 and the porter tokenizer verified on Node 25 / SQLite 3.53), which removes the native build step that `better-sqlite3` would require on every machine. Minimum Node is 22.13 (first line shipping `node:sqlite` without a flag); Node 20 reached EOL in April 2026 so this excludes no supported machine.

## Consequences

- New-machine setup is a clone plus `npm install && npm run build && npm link -w @doltap/cli`; no compiler toolchain needed.
- `node:sqlite` is still marked experimental in Node docs. If an API break lands, pin the Node major in `package.json#engines` and revisit; `better-sqlite3` remains the fallback.
- The search index lives at `.doltap/index.sqlite` (WAL mode) and is rebuilt incrementally from file mtimes, so it is safe to delete at any time.

## Related

- [[decisions/_index]]
- [[decisions/wiki-storage-markdown-git]]
