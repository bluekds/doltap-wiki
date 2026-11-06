# Security audit scope

This document briefs an independent auditor, human or model, who has no shared context with the
authors. It defines what Doltap is, who the attackers are, what is in and out of scope, how to set up
a disposable test environment, what earlier audits found, and how to report. Everything needed is in the
public repository; the auditor never needs, and must never be given, access to a real wiki.

## 1. What is being audited

Doltap Wiki is a shared knowledge base for AI agents: Markdown pages in a git repository, read and
written through an MCP server and a CLI, synchronised between machines through an ordinary git remote.
Three npm packages, one repository:

| Package | Role | Entry points |
|---|---|---|
| `@bluekds/doltap-core` (`packages/core`) | page parsing, lint, SQLite FTS5 index, git sync, locks, secrets filter, scaffold, scheduler install | library |
| `@bluekds/doltap-mcp` (`packages/mcp`) | the MCP server (16 tools, 3 resources) over stdio, and an HTTP service for remote clients | `doltap-mcp`, `doltap-mcp --http` |
| `doltap-wiki` (`packages/cli`) | the `doltap` command, client integrations, service installation | `doltap` |

Reference material, all generated from the code and checked in CI: [TOOLS.md](TOOLS.md) (every MCP tool and
argument), [CLI.md](CLI.md) (every command and flag), and the page protocol shipped in
`packages/core/skeleton/wiki/_meta/PROTOCOL.md`.

Audit the tag named in the request (for example `v0.11.1`), not `main`.

## 2. Deployment model and trust boundaries

```
 collaborators ──push──▶ git remote (GitHub, private) ◀──pull/push── every machine's clone
                                                               │
 machine A (always on): doltap-mcp --http on 127.0.0.1:8765 ◀──┤  state dir: ~/.local/state/doltap/<wiki-id>/
      ▲ Tailscale Funnel (TLS, public hostname)                 │     index.sqlite, write.lock, sync.json,
      │                                                         │     http-token, http-clients.json, logs/
 remote clients: claude.ai connector, Claude Code, Codex, Cursor, Gemini CLI
      (URL = https://host/<64-hex token>/mcp; named tokens may be read-only or expiring)

 machine B, C: doltap CLI and stdio MCP on a local clone, scheduled `doltap sync` (launchd / cron / schtasks)
```

Assets, from most to least sensitive:

1. The HTTP path token and named client tokens (`http-token`, `http-clients.json`): anyone holding one can
   read, and with a full-access token write, the whole wiki.
2. The host filesystem of the service machine: nothing the wiki contains or a client sends may read or
   write outside the wiki root and the state directory.
3. Wiki integrity: pages must not be lost, silently overwritten, or attributed to the wrong author; a
   conflict must surface, never resolve by discarding one side.
4. Availability of the service for its token holders.
5. Secret values must not enter the wiki (pages, attachments, tag descriptions, reports): the content is
   pushed to every clone and read by agents that send it to model providers.

Trust boundaries that the code is expected to enforce:

- **Git remote → clone.** Anyone with push access to the remote can place any file at any path in every
  clone: pages, templates, tags, `.obsidian` config, symlinks, a `.doltap/` directory. Doltap must treat
  everything that arrives through git as data: no path escapes, no symlink following, no state or token
  read from the tree, no code execution.
- **Token holder → service.** A valid token reaches the MCP tools. Read-only tokens must not write; no
  tool may reach outside the wiki; every input is validated and bounded; one client must not deny
  service to the others or learn the host's layout.
- **Anonymous internet → service.** The Funnel hostname is public. Without a valid token a request must
  cost the service nearly nothing and leak nothing (timing, logs, errors).
- **Processes on one machine.** Several doltap processes share a clone (CLI, stdio servers, HTTP service,
  scheduler). Their writes must serialise through the lock; a crashed writer must not block the others.
- **Same-user malware or a hostile home directory are out of scope** (see section 4).

## 3. In scope

- Path handling and filesystem boundaries: page ids, section names, attachment paths, template and
  protocol reads, symlinks at any depth, case-insensitive filesystems, Windows reserved names, URL
  encoding (`packages/core/src/safe.ts`, `page.ts`, `assets.ts`, `write.ts`, `template.ts`, `tags.ts`).
- Everything that arrives through `git pull`: hostile frontmatter and bodies (YAML, headings, fences,
  wikilinks, Markdown links), hostile `_meta/` files (tags, templates, stats, reports), `.obsidian`
  content, a pushed `.doltap/`, conflict copies, attachments (`lint.ts`, `secrets.ts`, `git.ts`, `audit.ts`,
  `report.ts`, `doctor.ts`, `upgrade.ts`).
- The HTTP service: token comparison, named clients, expiry, read-only enforcement, Host header checks,
  body limits, session handling and eviction, logging, token rotation, error messages
  (`packages/mcp/src/http.ts`, `server.ts`).
- MCP tool input validation and limits (`server.ts`, `docs/TOOLS.md`), including anything that could make
  a search or parse superlinear (ReDoS, FTS query construction, SQL).
- Git operations: command construction (`execFile`, no shell), pathspecs, commit scoping, pull/rebase
  with autostash, conflict resolution and copies, push retries, remote failure handling (`git.ts`).
- Concurrency: the write lock (`lock.ts`), async waiters in the HTTP server, auto-pull on reads, hub
  regeneration, the SQLite index under concurrent processes (`db.ts`, `query.ts`).
- State directory handling and migration (`config.ts`), file modes, the scheduler and service
  installation (`schedule.ts`: plist and crontab construction, Windows task command), the scaffold
  (`scaffold.ts`: `init --new` on existing directories).
- Secret handling: the secret filter and its false negatives, token masking in CLI output
  (`packages/cli/src/mask.ts`), what reaches logs and commit messages, integration config files written
  with tokens (`packages/cli/src/integrations.ts`).
- Supply chain as far as the repository controls it: dependency ranges, install scripts, what the
  published tarballs contain, the publish workflow (`.github/workflows/publish.yml`).

## 4. Out of scope

- Tailscale, Funnel and TLS termination; GitHub's own access control; the npm registry; Obsidian and its
  plugins as software (the wiki ships an `.obsidian` config and doltap warns about hostile changes to it,
  which is in scope).
- Compromise of the user account on a machine, malware with the user's privileges, physical access.
- Model behaviour: an agent that misuses a legitimate tool with a legitimate token is a policy question,
  not a vulnerability. Prompt injection through page content is in scope only where doltap itself acts
  on content (it never executes any).
- Denial of service that requires a valid full-access token and is indistinguishable from heavy use.

## 5. Test environment

Never audit against a real wiki or a real token. Build a disposable one:

```sh
git clone https://github.com/bluekds/doltap-wiki && cd doltap-wiki && git checkout v<version>
npm ci && npm run build && npm test                 # 270+ tests, ~2 min; the fixtures show every mechanism
node packages/cli/dist/main.js init --new --dir /tmp/audit-wiki
export DOLTAP_ROOT=/tmp/audit-wiki DOLTAP_STATE_HOME=/tmp/audit-state
node packages/cli/dist/main.js doctor
DOLTAP_HTTP_TOKEN=$(printf 'ab%.0s' $(seq 32)) node packages/mcp/dist/main.js --http --port 8765 --host 127.0.0.1
```

Useful test helpers in `packages/core/test/helpers.ts`: `makeTwoMachines()` builds a bare remote with two
clones, which is how every multi-machine and hostile-push scenario in the suite is reproduced. The
`v090-*`, `v091-*`, `v010-*`, `v011-*` test files are the regression tests of earlier findings and show the
expected behaviour per boundary. `packages/mcp/test/http.test.ts` drives the HTTP service in process.

The MCP tools can be exercised without a client: `packages/mcp/test/v091.test.ts` connects through an
in-memory transport. For hand testing over HTTP, `curl` with `Mcp-Session-Id` as in `http.test.ts`.

## 6. Earlier audits and what they changed

Two internal, independent audits ran before 0.9.0 (a security pass and a core-logic pass by agents with no
shared context with the author), 48 findings, every confirmed one fixed with a regression test. The
classes, so an external auditor can go past them or try to break the fixes:

| Class | Fix (release) |
|---|---|
| Symlinks under the wiki read or overwrite host files | every path component lstat-checked, links refused everywhere, lint reports them (0.9.0) |
| Pushed `.doltap/` files became the host's token or client list | state moved outside the tree, migrated once; anything in-tree is reported, never read (0.10.0) |
| Catastrophic regex backtracking in page parsing from one tool call | linear parsers, page/query/body size caps, FTS token cap (0.9.0) |
| Binary attachment conflicts corrupted both sides; conflict copies overwritten | byte-safe staging, numbered copies, generated files take upstream (0.9.0, 0.9.1) |
| Secrets reached attachments, tag descriptions, committed reports; token in CLI errors | filter on every write path, masked output (0.9.0) |
| A failed commit stranded files and misattributed authorship | rollback and path-scoped commits (0.9.1) |
| Git operations outside the write lock; stale-lock races | lock on every path, rename-based takeover (0.9.1, 0.11.0) |
| Unauthenticated requests logged one by one; session eviction across clients; token rotation needed a restart; absolute paths in errors | aggregated logging, per-client caps, hot reload, masked paths (0.9.1) |
| Hostile Obsidian config can run code when the vault is opened | detected and reported by sync and doctor; cannot be prevented by doltap (0.9.1) |
| Windows Task Scheduler action parsed differently from a shell | wrapper script (0.11.1) |

Known, accepted residual risks: a collaborator with push access can still make Obsidian run code on a
machine that opens the vault (reported, not prevented); the stale-lock takeover narrows but cannot close
the race between two processes that judged the same lock stale at the same instant; the 64-hex bare
secret pattern is not filtered because sha256 checksums in pages look identical.

## 7. Severity and reporting

| Severity | Meaning |
|---|---|
| Critical | a collaborator or a read-only token holder reads or writes outside the wiki, obtains a token, or runs code on the service host |
| High | wiki data lost or silently overwritten; a read-only token writes; service unavailable to others from one unauthenticated or read-only actor |
| Medium | integrity or availability issues needing a full-access token or unusual timing; secret leakage into logs or commits; misattribution |
| Low | hardening, robustness, documentation gaps |

For each finding: severity, location (file and line at the audited tag), a reproduction (commands or a
test against the fixtures; a failing test under `packages/*/test/` is the best form), impact, and a
suggested fix. Separate what was reproduced from what is plausible from reading. State what was examined
and found sound, so coverage is visible. Deliver the report as a Markdown file; do not open a public
issue for Critical or High findings before the maintainer has shipped a fix (GitHub private vulnerability
reporting on the repository, or the maintainer's contact in `package.json`).

## 8. Brief for a model-driven audit

When the auditor is an agent (the authors use one from a different vendor than the one that writes the
code), give it this document and nothing else from the authors, in a fresh clone of the tag, and ask it to:

1. Read sections 2 to 4 and `docs/TOOLS.md`, then the source in the order of section 3.
2. Run the test suite once and read the regression tests named in section 5 before trying to break
   the mechanisms they pin.
3. Attempt every boundary in section 2 with concrete inputs in the disposable environment; prefer
   reproductions over reasoning, and keep each attempt's commands.
4. Write the report in the form of section 7, severity first, reproduced findings before plausible ones,
   ending with the list of areas examined without a finding.

The maintainer then turns each confirmed finding into a failing test, fixes it, and records the audit
with its date and the auditor in the CHANGELOG and ROADMAP.
