# Compatibility policy

What a doltap release promises not to break, from 1.0.0 on. Before 1.0 the same rules are followed where
practical, and every exception is called out in the CHANGELOG.

The short version: **wikis, agents and scripts written against 1.x keep working on every later 1.x.**
Anything that would break them waits for 2.0, and is announced at least one minor release before it goes.

## 1. Versioning

doltap follows [semver](https://semver.org) across its three packages, which always share one version
(`doltap-wiki`, `@bluekds/doltap-mcp`, `@bluekds/doltap-core`, each pinning the others exactly).

| Release | May contain |
|---|---|
| Patch (1.0.x) | Fixes, security fixes, ranking tweaks, documentation. No interface change. |
| Minor (1.x.0) | New tools, arguments, commands, flags, frontmatter fields, output fields, lint rules; deprecations. |
| Major (x.0.0) | Removals and renames of anything in section 2, changed meaning of an existing argument or field. |

A security fix may tighten what is accepted (a path, a name, a header) in a patch release, as 0.11.2 and
0.13.2 did, when accepting it was the vulnerability. The CHANGELOG says so under the release.

## 2. The contract

These are frozen at 1.0. "Frozen" means: not removed, not renamed, and not given a different meaning within
1.x. New optional parts may be added.

**MCP interface** (`docs/TOOLS.md`, generated from the server's schemas)
- Tool names, argument names, argument types, and which arguments are required.
- Defaults of optional arguments, where the default changes what the tool does.
- Resource URIs (`wiki://protocol`, `wiki://index`, `wiki://tags`) and their media types.
- Output fields of the JSON results: a field present in 1.0 stays, with the same meaning. New fields can
  appear; clients must ignore fields they do not know.
- Error behaviour: a refused write stays a tool error (`isError`) with a reason, not a silent no-op.

**CLI** (`docs/CLI.md`, generated from the command definitions)
- Command names and subcommand paths, positional arguments, option flags and their short forms.
- `--json` output: same additive rule as the MCP results.
- Exit codes: 0 success; 1 failure (an error, lint errors, `golden` misses, `doctor` failures); 2 a write
  refused by a check (lint error in the new text, stale `base_rev`, existing id, deprecated page).
- Human-readable output is **not** part of the contract; parse `--json`.

**Wiki format** (what lives in the git repository)
- Layout: `wiki/<category>/…` for the five categories (`howto`, `patterns`, `reference`, `decisions`,
  `projects`), `wiki/Home.md`, hubs at `<category>/_index.md`, `wiki/_meta/` (`PROTOCOL.md`, `tags.yaml`,
  `templates/`, `stats/`, `reports/`, `golden.json`), attachments at `wiki/_assets/<page id>/<file>`.
- Page ids: `<category>/<kebab-slug>` segments of letters, digits, `-` and `_`.
- Frontmatter fields and their meaning: `title`, `category`, `summary`, `tags`, `aliases`, `confidence`
  (`draft` | `verified` | `deprecated`), `created`, `updated`, `sources`, `review_by`, `verified_on`,
  `verified_by`, `replaced_by`.
- Commit trailers written by doltap: `[host:…] [agent:…] [session:…]`.
- The PROTOCOL's section structure (sections 1 to 7). Wording inside a section may improve in any
  release; `doltap upgrade` shows and applies it.

A wiki written by 1.x is read by every later 1.x. A frontmatter field an older 1.x does not know is kept
as it is when that version edits the page, so machines on different minor versions can share one wiki
(`packages/core/test/compat.test.ts`).

**Configuration and services**
- Environment variables: `DOLTAP_ROOT`, `DOLTAP_AGENT`, `DOLTAP_SESSION`, `DOLTAP_STATE_HOME`,
  `DOLTAP_STATE_DIR`, `DOLTAP_REMOTE_URL`, `DOLTAP_REMOTE_TIMEOUT_MS`, `DOLTAP_NO_SYNC`,
  `DOLTAP_AUTO_PULL_MINUTES`, `DOLTAP_DEFER_PUSH`, `DOLTAP_HTTP_TOKEN`, `DOLTAP_HTTP_PORT`,
  `DOLTAP_HTTP_HOST`, `DOLTAP_HTTP_ALLOWED_HOSTS`.
- HTTP endpoints: `/<token>/mcp` (Streamable HTTP MCP) and `/healthz`.
- State directory location (`$DOLTAP_STATE_HOME`, else `$XDG_STATE_HOME/doltap/<wiki-id>/`, on Windows
  `%LOCALAPPDATA%\doltap\state\<wiki-id>\`) and the files a person may edit or back up there:
  `http-token`, `http-clients.json` (`{ name: { token, readOnly, created, expires? } }`).
- Service names: `com.doltap.sync.<wiki-id>`, `com.doltap.mcp.<wiki-id>`, `DoltapSync-<wiki-id>`, the cron
  marker `# doltap-sync <wiki-id>`.

## 3. Not part of the contract

- The JavaScript API of `@bluekds/doltap-core` and `@bluekds/doltap-mcp`. They are published so the CLI can
  depend on them; their exports change whenever the tools need it. Depend on the CLI or the MCP server.
- The search index (`index.sqlite` in the state directory). It is a cache rebuilt from the pages; its
  schema changes in any release and is migrated (or rebuilt) on first use.
- Other state files (`sync.json`, `write.lock`, `logs/`, `sync.cmd`, `upgrade-tmp/`): internal, migrated
  automatically.
- Ranking scores and the order of near-tied results. Ranking improves in patch releases; the golden set
  (`doltap golden`) is how a wiki checks that its own important queries still land first.
- Lint warnings. New warnings can appear in a minor release. A new lint **error** that would block writes
  to existing pages appears only as a warning first, for at least one minor release, unless it closes a
  security hole.
- Human-readable CLI output, log line formats, server instruction wording, skill and integration text.
- Generated files in the wiki (hub lists, `_meta/index.md`, reports): regenerated by each version.

## 4. Deprecation

1. A part of the contract that is going away is marked deprecated in a minor release: the CHANGELOG says
   so, `docs/TOOLS.md` / `docs/CLI.md` say so in its description, and using it prints a warning (CLI to
   stderr; MCP in the tool result's text).
2. It keeps working for the rest of that major version. The earliest removal is the next major.
3. Where a replacement exists, it ships in the same release as the deprecation.

## 5. Migration

- Files doltap owns (state directory, index, service definitions) migrate automatically on first use of the
  new version, report what they moved, and never need a manual step within a major version. Service definitions that embed a path are rewritten by `doltap serve install` /
  `doltap schedule install`; `doltap doctor` says when that is needed.
- Files people own (pages, `tags.yaml`, `PROTOCOL.md`, templates, `.obsidian/`) are never rewritten by an
  upgrade without asking: `doltap upgrade` shows the diff and applies only what is confirmed.
- A major release documents every manual step in an upgrade section of the CHANGELOG and, where it can,
  ships a command that does it.

## 6. Supported platforms

- Node.js: the versions in the packages' `engines` field (currently `>=22.13`). Dropping a Node line that is
  still maintained upstream is a major change; dropping one past its end of life is a minor change,
  announced one minor release ahead.
- Operating systems: macOS (launchd), Linux (cron), Windows (Task Scheduler), each tested in CI.
- Git: 2.x with `pull --rebase --autostash` (any Git from the last several years).

## 7. How the contract is checked

`docs/TOOLS.md` and `docs/CLI.md` are generated from the code and compared in CI (`npm run reference:check`),
so every change to a tool, argument, command or flag shows up in a pull request diff. A removal or rename in
those files during 1.x is a major change by this policy and is refused in review.
