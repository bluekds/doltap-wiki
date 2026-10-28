---
title: Why the tooling is TypeScript
category: decisions
summary: >-
  Why the CLI and MCP server are TypeScript on Node 22 with built-in sqlite instead of Python or Go.
tags:
  - tooling
  - architecture
confidence: verified
created: 2026-07-05
updated: 2026-07-05
sources: []
---
## Context

One language for CLI, MCP server and an optional Obsidian plugin.

## Decision

TypeScript, Node 22.13+, `node:sqlite`; no native modules.

## Consequences

- Windows works without a compiler.
