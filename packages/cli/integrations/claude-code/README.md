# Claude Code integration

After `doltap init` on a machine (see `howto/setup-wiki-on-new-machine` in the wiki), one command installs everything at user scope:

```sh
doltap integrations install claude            # local stdio server (needs the clone)
doltap integrations install claude --remote <URL>   # always-on HTTPS endpoint, no clone needed
doltap integrations install claude --dry-run  # show the changes first
```

It writes the skill to `~/.claude/skills/doltap/SKILL.md`, appends the `## Doltap` section of `CLAUDE.md.snippet` to `~/.claude/CLAUDE.md` (once), and runs `claude mcp add -s user doltap …`. `doltap integrations uninstall claude` reverses the first and last.

Verify inside a new Claude Code session: `/mcp` shows `doltap` connected; ask "search the wiki for obsidian".

## Manual equivalent

```sh
claude mcp add -s user doltap -e DOLTAP_ROOT="$HOME/.doltap" -e DOLTAP_AGENT=claude-code -- "$(which doltap-mcp)"
mkdir -p ~/.claude/skills/doltap && cp skills/doltap/SKILL.md ~/.claude/skills/doltap/
cat CLAUDE.md.snippet >> ~/.claude/CLAUDE.md
```

Other MCP clients: run `doltap-mcp` over stdio with the same two environment variables. The resource `wiki://protocol` carries the full rules, so a client without skills still gets them.

## Windows (PowerShell)

Requires Node >= 22.13 and Git for Windows on `PATH`.

```powershell
npm install -g doltap-wiki
doltap init --repo git@github.com:<org>/<wiki-repo>.git     # clones to $HOME\.doltap
doltap integrations install claude                           # registers node + the MCP JS entry (the .cmd shim is not launched reliably)
doltap schedule install                                      # Task Scheduler, every 10 minutes
```

Line endings: `.gitattributes` forces LF for every text file, so leave `core.autocrlf` at its default; the parser also tolerates CRLF.
