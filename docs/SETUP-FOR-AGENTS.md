# Doltap Wiki: setup instructions for an AI agent

You are an AI coding agent (Claude Code, Codex, Cursor, or similar) and your user asked you to set up **Doltap Wiki** on this machine. Follow these steps in order. Ask the user only the questions marked **ASK**; decide everything else yourself and report what you did at the end.

Doltap Wiki is a Markdown + git knowledge base that agents on several machines write to and read from. It gives you an MCP server (`doltap-mcp`) and a CLI (`doltap`). Repository: https://github.com/bluekds/doltap-wiki

**Work from the home directory.** Run `cd ~` first and stay there: `doltap` picks the nearest wiki above the current directory before `~/.doltap`, so running it from inside some other checkout would target the wrong wiki. If you cannot change directory, pass `--root ~/.doltap` to every `doltap` command.

## 0. Preconditions

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

## 2. Git identity

Wiki commits carry the user's identity. Check `git config --global user.email`. If it is empty, **ASK** for the name and email to use; keep the answer for step 3. (Do not set them globally unless the user asks; you will set them on the wiki clone.)

## 3. Decide: new wiki, existing wiki, or remote endpoint

**ASK** the user: "Do you already have a Doltap wiki (a git URL), should I create a new one, or did you get a remote endpoint URL (https://…/mcp) to use without a local clone?"

### 3a. New wiki

The wiki needs an empty private git repository. If the GitHub CLI is available and authenticated (`gh auth status` succeeds), offer to create one:

```sh
gh repo create <owner>/<name> --private --description "Doltap wiki"
```

If `gh` is unavailable or not authenticated, **ASK** the user to create an empty private repository (no README) and give you its URL, or continue without `--remote` and report the push command at the end.

Then scaffold, and set the identity on the clone:

```sh
doltap init --new --dir ~/.doltap --remote git@github.com:<owner>/<name>.git
git -C ~/.doltap config user.name "<name>"
git -C ~/.doltap config user.email "<email>"
```

Notes: the initial scaffold commit is authored as `doltap <doltap@localhost>`; that is expected. `init` prints `next: export DOLTAP_ROOT=…`; ignore it when using the default `~/.doltap`. If the push fails (no SSH key, remote missing), the wiki still exists locally with `origin` configured; tell the user to run `git -C ~/.doltap push -u origin main` later and continue.

### 3b. Existing wiki

```sh
doltap init --repo <git-url>        # clones to ~/.doltap and builds the search index
git -C ~/.doltap config user.name "<name>"
git -C ~/.doltap config user.email "<email>"
```

### 3c. Remote endpoint (no clone)

The user gives you an HTTPS URL that ends in `/mcp` and contains a secret token. Never print it back into the conversation or into any file other than the client configuration. Run:

```sh
DOLTAP_REMOTE_URL='<URL>' doltap integrations install claude --remote
```

Then skip to step 7. Steps 4 to 6 do not apply (there is no local clone, no sync schedule, nothing to lint).

## 4. Connect the agent client

For Claude Code, first preview, then apply (user scope: every project on this machine):

```sh
cd ~
doltap integrations install claude --dry-run    # check that the DOLTAP_ROOT shown is ~/.doltap
doltap integrations install claude
```

This writes the skill to `~/.claude/skills/doltap/`, appends a `## Doltap Wiki` section to `~/.claude/CLAUDE.md` (once), and registers the MCP server, replacing any existing user-scope `doltap` registration.

For any other MCP client, register `doltap-mcp` as a stdio server with environment variables `DOLTAP_ROOT=<absolute path of ~/.doltap, e.g. /Users/<you>/.doltap>` and `DOLTAP_AGENT=<client name>`. Most client config files do not expand `~`. The MCP resource `wiki://protocol` carries the writing rules, so the client needs no extra skill.

## 5. Periodic sync

```sh
cd ~
doltap schedule install          # launchd (macOS), crontab (Linux) or Task Scheduler (Windows), every 10 minutes
doltap schedule status
```

The entry records the absolute paths of Node and `doltap`, so re-run `doltap schedule install` after moving Node or the wiki. On macOS and Linux the first run happens right away; check that `~/.doltap/.doltap/logs/sync.err` is empty (or absent) a minute later.

## 6. Verify

```sh
cd ~
doltap lint                      # expect: 0 error(s)
doltap search obsidian           # expect: reference/obsidian-conventions first
doltap sync                      # expect: pulled: true ... offline: false (a new wiki has 9 pages)
doltap doctor                    # expect: 0 failure(s); warnings name the command that clears them
```

For Claude Code also run `claude mcp get doltap` and expect `Status: ✔ Connected`.

## 7. Report to the user

Tell the user, briefly:

- where the wiki lives (`~/.doltap`) and which remote it syncs with, or that it uses the remote endpoint
- that **new agent sessions** will see the `doltap` MCP server and skill (the current session will not until restarted)
- how to open it in Obsidian: open `~/.doltap/wiki` as a vault (not the repository root) and install the Dataview and Obsidian Git community plugins
- that they can now say things like "check the wiki for X before you start" or "record what we just learned in the wiki"
- anything you could not finish (push, identity, PATH) and the exact command to finish it

## Rules while you work

- Do not paste secrets (tokens, keys, remote URLs with tokens) into the conversation or into wiki pages.
- Write only to `~/.doltap`, `~/.claude`, the npm global prefix and cache, and the scheduler entry that `doltap schedule install` creates (launchd plist, crontab line or Task Scheduler task).
- If a step fails twice, stop and show the user the error instead of improvising.
