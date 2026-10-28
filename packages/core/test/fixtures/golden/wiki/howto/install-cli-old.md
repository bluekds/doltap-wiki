---
title: Install the wiki CLI from source
category: howto
summary: >-
  Build the CLI from a checkout and link it; set up a new machine the manual way used before the npm package existed.
tags:
  - wiki
  - tooling
confidence: draft
created: 2026-06-01
updated: 2026-06-01
sources: []
---
## Prerequisites

- A checkout of the tool repository.

## Steps

1. `npm install && npm run build`
2. `npm link` in the cli package.
3. Clone the wiki to `~/.doltap` and set up the machine by hand: register the MCP server with the absolute path.

## Verification

`doltap --version` prints the version.

## Pitfalls

- Linked builds go stale after a pull; rebuild.

## Related

- [[howto/setup-new-machine]]
