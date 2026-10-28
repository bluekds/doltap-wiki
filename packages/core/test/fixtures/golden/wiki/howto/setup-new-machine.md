---
title: Set up doltap on a new machine
category: howto
summary: >-
  Install the CLI, clone the wiki, register the MCP server and the skill for the agents on a new laptop or server.
tags:
  - wiki
  - tooling
confidence: verified
created: 2026-09-20
updated: 2026-10-20
sources: []
---
## Prerequisites

- Node 22.13 or newer; git with access to the wiki repository.

## Steps

1. `npm i -g doltap-wiki`
2. `doltap init --repo git@github.com:<org>/<wiki>.git`
3. `doltap integrations install claude-code`
4. `doltap doctor`

## Verification

`doltap search wiki` returns pages; the agent sees the `doltap` MCP server.

## Pitfalls

- A missing git identity makes every write fail; set user.name and user.email first.

## Related

- [[howto/install-cli-old]]
