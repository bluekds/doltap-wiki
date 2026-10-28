---
title: Why the wiki is Markdown in git
category: decisions
summary: >-
  Why pages are Markdown files in a git repository rather than a database or a SaaS wiki: diffable, offline, agent-friendly, Obsidian-readable.
tags:
  - wiki
  - architecture
confidence: verified
created: 2026-07-01
updated: 2026-07-01
sources: []
---
## Context

Agents on several machines need shared, versioned knowledge.

## Decision

Markdown files in a private git repository, one page per file, synced by the CLI.

## Consequences

- Conflicts are handled with conflict copies, not locks.
- Search needs a local index (FTS5).
