# FAQ

## How is this different from …

Comparisons are as of November 2026, from each project's own documentation (linked). Tools change; if a
line here is out of date, an issue or PR is welcome.

The short answer: Doltap Wiki is a **curated, shared** knowledge base. Agents write to it on purpose,
through rules (categories, templates, lint, duplicate checks, a secret filter, `draft` → `verified` with
evidence), and every machine syncs it through a git remote you already have. No server to run, no account.
Most memory tools aim at the opposite: capture everything automatically, for one agent or through one
server.

### CLAUDE.md / AGENTS.md

Instruction files for one repository (or one user), loaded into the agent's context every session
([Claude Code memory](https://code.claude.com/docs/en/memory),
[Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)). Keep using them: rules
about *this* repository belong there, and they cost nothing to set up.

Doltap holds what crosses repositories and machines (how you release, how to call the inference box, why
you picked SQLite, the pitfall you hit last month) and is searched on demand instead of loaded whole, so it
can grow past what fits in a context window.

### Claude Code auto memory, Codex memories

Notes the agent keeps for itself. Both are machine-local and tied to one vendor: Claude Code's are "not
shared across machines or cloud environments", Codex's live under `$CODEX_HOME` and are off by default
([Claude Code](https://code.claude.com/docs/en/memory),
[Codex](https://learn.chatgpt.com/docs/customization/memories?surface=app)). Doltap is one store for
Claude Code, Codex, Cursor and Antigravity CLI (formerly Gemini CLI) on every machine you use.

### claude-mem, agentmemory, ai-memory

Automatic capture: hooks record what the agent does and the tool distils it
([claude-mem](https://github.com/thedotmack/claude-mem), [agentmemory](https://github.com/rohitg00/agentmemory),
[ai-memory](https://github.com/akitaonrails/ai-memory)). If you want memory with zero writing effort,
they are the better choice.

ai-memory is the closest in shape: a git-backed Markdown wiki with a derived SQLite index, readable in
Obsidian, for many agents. It is built around something else, though:

- **Scope.** ai-memory remembers a repository ("this repo, not a general vault"): each project has its own
  wiki, and its strength is continuity inside that project. A session that stops in Claude Code resumes in
  Codex with a claim-once handoff of what failed and what is still open. Across projects it carries a small
  profile of your usual choices, and searching every project is an explicit `--global` query. Doltap is one
  wiki for everything you work on: how you release, how to reach a machine, the pitfall you hit in another
  repository. A page belongs to a subject, not to a repository.
- **Time.** ai-memory turns sessions into pages and can age them (decay, compaction, dedup; the parts that
  rewrite content are off by default). Doltap pages are reference material that stays until someone marks
  it `deprecated` and names its replacement.
- **Writing.** ai-memory captures automatically through hooks, and agents can also write pages. Doltap
  pages are written deliberately, follow their category's template, and start as `draft` until another
  session verifies them with evidence.
- **Sharing.** ai-memory runs one server that every machine and teammate points at, live. Doltap needs no
  server: every machine has a full clone, works offline and syncs through the git remote, so another
  machine sees a write after its next sync.

They answer different questions and can run side by side: ai-memory for "where did this repository's work
stop", Doltap for "how do we do this", across all of them.

### Basic Memory

Local Markdown notes with an MCP server and Obsidian support
([basic-memory](https://github.com/basicmachines-co/basic-memory)), AGPL-3.0. Syncing between machines
is left to you ("Git or Syncthing") or to its paid cloud. Doltap ships the sync (a scheduled
`doltap sync`, write locking, conflict copies, offline backoff) and write rules aimed at several agents
sharing one store, under MIT.

### mem0

A memory layer that extracts facts with an LLM and embeddings; the MCP route is its hosted platform
([mem0](https://github.com/mem0ai/mem0), [mem0 MCP](https://docs.mem0.ai/platform/mem0-mcp)). Good for
personalisation facts. Doltap stores documents (procedures, decisions, references) that people read and
edit, and never calls a model.

### An Obsidian vault with an MCP server

That gives agents file access to a vault ([mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian)).
Doltap is that plus the parts that make many writers safe: page ids and categories, templates, lint, a
secret filter, duplicate detection, `base_rev` checks so nobody overwrites an edit they did not see, git
sync with conflict handling, search ranking, and an audit of stale or unread pages. You still read it in
Obsidian.

## Other questions

**Do agents actually use it?** `doltap integrations install <agent>` installs the MCP server, a skill and
a short instruction section, and the server tells every client when to search and when to write. Agents
follow it most of the time, not always; saying "check the wiki first" in a request settles it.

**Where does my data go?** Your machines and your git remote. Doltap's only network traffic is git to your
remote and its own MCP service for the clients you allow; there is no telemetry and no account.

**Secrets?** Writes containing a token, key or password are refused; pages record where a secret lives
and how to load it. The filter also covers attachments, tag descriptions and committed reports.

**A team?** Everyone with access to the git repository shares the wiki. The HTTP server adds named,
expiring, optionally read-only tokens for machines that only reach it remotely. Access is per wiki, not
per page.

**Windows?** Supported and tested in CI; scheduling uses the Task Scheduler.

**Is it stable?** See [COMPATIBILITY.md](COMPATIBILITY.md) for what 1.x promises not to break, and
[SECURITY-AUDIT-SCOPE.md](SECURITY-AUDIT-SCOPE.md) for the audits so far.
