---
title: Set up Doltap on a new machine
category: howto
summary: >-
  Clone the wiki repo, build the CLI, link the wiki command, and verify sync.
  Required once per machine that runs agents.
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
- git with push access to `github.com/<org>/<wiki-repo>` (SSH key or `gh auth login`)

## Steps

1. Clone to the default location:

   ```sh
   git clone git@github.com:<org>/<wiki-repo>.git ~/.doltap
   ```

2. Build and link the CLI:

   ```sh
   cd ~/.doltap && npm install && npm run build && npm link -w @doltap/cli
   ```

3. Set the git identity for this clone (used in commit messages):

   ```sh
   git -C ~/.doltap config user.name "<name>" && git -C ~/.doltap config user.email "<email>"
   ```

4. Build the local index: `doltap reindex --full`
5. Optional: set `DOLTAP_AGENT=<client-name>` in the agent's environment so commits record which client wrote them.

6. Register the MCP server and skill for Claude Code (other clients: run `doltap-mcp` over stdio):

   ```sh
   npm link -w @bluekds/doltap-mcp
   claude mcp add -s user doltap -e DOLTAP_ROOT="$HOME/.doltap" -e DOLTAP_AGENT=claude-code -- "$(which doltap-mcp)"
   cp -r ~/.doltap/integrations/claude-code/skills/wiki ~/.claude/skills/
   cat ~/.doltap/integrations/claude-code/CLAUDE.md.snippet >> ~/.claude/CLAUDE.md
   ```

7. Install the periodic sync so reads never block on a slow pull: `doltap schedule install` (launchd on macOS, crontab on Linux; every 10 minutes). Check with `doltap schedule status`.

Windows (PowerShell) equivalents for steps 1-7 are in `integrations/claude-code/README.md`; the only real differences are registering the MCP server as `node <path>\packages\mcp\dist\main.js` instead of the `.cmd` shim, and `doltap schedule install` using Task Scheduler.

## Verification

- `doltap lint` prints `0 error(s)`
- `doltap search obsidian` returns `reference/obsidian-conventions`
- `doltap sync` prints `pulled: true pushed: false offline: false`

- `claude mcp get doltap` shows the server; inside a Claude Code session, `/mcp` lists `doltap` as connected

## Pitfalls

- If `wiki` is not found after `npm link`, the npm global bin dir is not on `PATH`; run `npm prefix -g` and add `<prefix>/bin`.
- Do not clone the repo into a directory that another tool syncs (Dropbox, iCloud): two sync layers on one git repo corrupt `.git`.
- If the machine also runs Obsidian, open `~/.doltap/wiki` (not the repo root) as the vault.

- `doltap schedule install` on macOS needs the `wiki` binary on a path launchd can see; the plist hardcodes the path from `which wiki`, so re-run install after moving Node or the repo.

- Windows: do not set `core.autocrlf=true` for this repo; `.gitattributes` already pins LF and CRLF files would make every agent edit a whole-file diff. Status of the Windows path: code paths are covered by tests, but no real Windows machine has run the setup yet — if you are the first, record what broke here.

## Related

- [[howto/_index]]
- [[howto/add-wiki-page-manually]]
- [[decisions/wiki-tooling-typescript]]
