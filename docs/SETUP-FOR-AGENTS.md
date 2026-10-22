# Doltap Wiki: setup instructions for an AI agent

You are an AI coding agent (Claude Code, Codex, Cursor, or similar) and your user asked you to set up **Doltap Wiki** on this machine. Follow these steps in order. Ask the user only the questions marked **ASK**; decide everything else yourself and report what you did at the end.

Doltap Wiki is a Markdown + git knowledge base that agents on several machines write to and read from. It gives you an MCP server (`doltap-mcp`) and a CLI (`doltap`). Repository: https://github.com/bluekds/doltap-wiki

## 0. Preconditions

Run and check:

```sh
node -v     # must be 22.13 or newer
git --version
```

If Node is missing or too old, tell the user how to install it for their OS (nvm, Homebrew, winget, or nodejs.org) and stop until it is available. Do not install Node yourself unless the user asks.

## 1. Install the tool

```sh
npm install -g doltap-wiki
doltap --version
```

If `doltap` is not found afterwards, the npm global bin directory is not on `PATH`: run `npm prefix -g` and add `<prefix>/bin` (Windows: `<prefix>`) to `PATH`, then retry.

## 2. Decide: new wiki or existing wiki

**ASK** the user: "Do you already have a Doltap wiki repository (a git URL), or should I create a new one?"

### 2a. New wiki

The wiki needs a private git repository. If the GitHub CLI is available and authenticated (`gh auth status`), offer to create one:

```sh
gh repo create <owner>/<name> --private --description "Doltap wiki" 
```

Then scaffold and push:

```sh
doltap init --new --dir ~/.doltap --remote git@github.com:<owner>/<name>.git
```

If the push fails (no SSH key, no remote yet), the wiki still exists locally; tell the user the exact `git push -u origin main` to run later and continue.

### 2b. Existing wiki

```sh
doltap init --repo <git-url>        # clones to ~/.doltap and builds the search index
```

## 3. Git identity for this clone

Commits made by agents carry the user's identity. Check `git -C ~/.doltap config user.email`; if empty, **ASK** for the name and email to use and set them:

```sh
git -C ~/.doltap config user.name "<name>"
git -C ~/.doltap config user.email "<email>"
```

## 4. Connect the agent client

For Claude Code (installs the skill, the global CLAUDE.md section and the MCP registration at user scope):

```sh
doltap integrations install claude
```

For any other MCP client, register `doltap-mcp` as a stdio server with environment variables `DOLTAP_ROOT=<path to ~/.doltap>` and `DOLTAP_AGENT=<client name>`. The MCP resource `wiki://protocol` carries the writing rules, so the client needs no extra skill.

If the user wants to use a remote wiki endpoint instead of a local clone, they will give you an HTTPS URL. Register it with `doltap integrations install claude --remote <URL>` and skip steps 2, 3 and 5. Never print that URL back into the conversation: it contains a secret token.

## 5. Periodic sync

```sh
doltap schedule install          # launchd (macOS), crontab (Linux) or Task Scheduler (Windows), every 10 minutes
doltap schedule status
```

## 6. Verify

```sh
doltap lint                      # expect: 0 error(s)
doltap search obsidian           # expect: reference/obsidian-conventions
doltap sync                      # expect: pulled: true ... offline: false
```

For Claude Code also run `claude mcp get doltap` and expect `Status: ✔ Connected`.

## 7. Report to the user

Tell the user, briefly:

- where the wiki lives (`~/.doltap`) and which remote it syncs with
- that **new agent sessions** will see the `doltap` MCP server and skill (the current session will not until restarted)
- how to open it in Obsidian: open `~/.doltap/wiki` as a vault (not the repository root) and install the Dataview and Obsidian Git community plugins
- that they can now say things like "check the wiki for X before you start" or "record what we just learned in the wiki"
- anything you could not finish (push, identity, PATH) and the exact command to finish it

## Rules while you work

- Do not paste secrets (tokens, keys, remote URLs with tokens) into the conversation or into wiki pages.
- Do not modify files outside `~/.doltap`, `~/.claude` and the npm global prefix.
- If a step fails twice, stop and show the user the error instead of improvising.
