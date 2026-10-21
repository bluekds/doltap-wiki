---
title: Set up Doltap on a new machine
category: howto
summary: >-
  Install the doltap CLI, clone the wiki repository, register the MCP server
  and skill for the agent, and install the periodic sync. Once per machine.
tags:
  - wiki
  - tooling
  - git
confidence: draft
created: 2026-10-18
updated: 2026-10-18
sources: []
---
## Prerequisites

- Node 22.13 or newer (`node -v`)
- git with push access to the wiki repository (SSH key or `gh auth login`)
- The wiki repository already exists (created with `doltap init --new` on the first machine)

## Steps

1. Install the CLI and MCP server:

   ```sh
   npm install -g doltap-wiki
   ```

2. Clone the wiki to the default location and build the local index:

   ```sh
   doltap init --repo git@github.com:<org>/<wiki-repo>.git
   ```

3. Set the git identity for this clone (used in commit messages):

   ```sh
   git -C ~/.doltap config user.name "<name>" && git -C ~/.doltap config user.email "<email>"
   ```

4. Register the MCP server, the skill and the global instruction for Claude Code:

   ```sh
   doltap integrations install claude
   ```

   Other MCP clients: run `doltap-mcp` over stdio with `DOLTAP_ROOT=$HOME/.doltap` and `DOLTAP_AGENT=<client-name>` in its environment.

5. Install the periodic sync so reads never block on a slow pull: `doltap schedule install` (launchd on macOS, crontab on Linux, Task Scheduler on Windows; every 10 minutes). Check with `doltap schedule status`.

6. Optional: open `~/.doltap/wiki` (not the repository root) as an Obsidian vault; see [[reference/obsidian-conventions]].

## Verification

- `doltap lint` prints `0 error(s)`
- `doltap search obsidian` returns `reference/obsidian-conventions`
- `doltap sync` prints `pulled: true pushed: false offline: false`
- `claude mcp get doltap` shows the server; inside a new Claude Code session, `/mcp` lists `doltap` as connected

## Pitfalls

- If `doltap` is not found after `npm install -g`, the npm global bin dir is not on `PATH`; run `npm prefix -g` and add `<prefix>/bin`.
- Do not clone the repo into a directory that another tool syncs (Dropbox, iCloud): two sync layers on one git repo corrupt `.git`.
- `doltap schedule install` records the absolute path of the `doltap` binary; re-run it after moving Node or the repo.
- Windows: do not set `core.autocrlf=true` for this repo; `.gitattributes` already pins LF and CRLF files would make every agent edit a whole-file diff.

## Related

- [[howto/_index]]
- [[howto/add-wiki-page-manually]]
- [[reference/obsidian-conventions]]
