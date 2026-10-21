---
title: Store the wiki as Markdown + git
category: decisions
summary: Why the agent wiki uses Markdown files in a GitHub private repo instead of a database or SaaS. Token efficiency, offline use, multi-machine sync.
tags: [wiki, git, obsidian]
confidence: verified
created: 2026-10-18
updated: 2026-10-18
sources:
  - "Doltap design session, 2026-10-18"
---

## Context

AI agents running on several machines (Claude Code today, other clients later) need to search, read, and register shared knowledge. Humans need a UI to browse and edit. Server operation should be minimal.

## Options

| Option | Pros | Cons |
|---|---|---|
| Markdown + git (GitHub private) | Token-efficient, zero dependencies, works offline, git handles history/sync/conflicts, Obsidian provides the UI | No built-in UI, concurrent edit conflicts must be handled by tooling |
| Notion | Good human UI, MCP available | API round-trip per call, no offline, hard to enforce write format for agents |
| Self-hosted Wiki.js / Outline | Search and permissions built in | Server to operate, agents still go through an API |
| Vector DB RAG | Semantic search | At a few hundred pages BM25 is equivalent; only adds operational burden |

## Decision

Markdown + git. Files are the source of truth; the search index (sqlite FTS5) is a per-machine derivative and is never committed. Obsidian is the human UI ([[reference/obsidian-conventions]]).

## Consequences

- Every write must run `pull --rebase → lint → commit → push` automatically. The CLI / MCP server owns this responsibility.
- Frequently changing derived files such as `index.md` are not committed (the number one cause of conflicts).
- Embedding search is revisited when the wiki exceeds ~500 pages and synonym misses become noticeable.
- Support for other clients is absorbed by the MCP server ([[decisions/wiki-tooling-typescript]]).

## Related

- [[decisions/_index]]
- [[decisions/wiki-tooling-typescript]]
