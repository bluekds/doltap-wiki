# CLI reference

Generated from the command definitions by `npm run reference` (`doltap --reference`); do not edit by hand. `doltap` 0.11.0: 48 commands.

Doltap: shared knowledge base for AI agents. Global options apply to every command:

| Option | Required | Default | Description |
|---|---|---|---|
| `-V, --version` | no |  | output the version number |
| `--root <path>` | no |  | wiki repository root (default: $DOLTAP_ROOT, nearest ancestor, or ~/.doltap) |
| `--agent <name>` | no |  | client identity for commit messages (default: $DOLTAP_AGENT or cli) |
| `--session <id>` | no |  | session id for commit messages |
| `--no-sync` | no |  | do not pull/push (local only) |
| `--json` | no |  | machine-readable output |

## Commands

- [`doltap init`](#doltap-init): set up a wiki on this machine
- [`doltap search`](#doltap-search): full-text search (title/summary/tags weighted above body)
- [`doltap get`](#doltap-get): print a page (or one section) by id, e.g
- [`doltap list`](#doltap-list): list pages
- [`doltap index`](#doltap-index): print the generated one-line-per-page index
- [`doltap protocol`](#doltap-protocol): print _meta/PROTOCOL.md
- [`doltap template`](#doltap-template): print the page template for a category with today's date filled in
- [`doltap tags`](#doltap-tags): tag vocabulary
- [`doltap tags list`](#doltap-tags-list): print the tag vocabulary with descriptions and usage counts
- [`doltap tags add`](#doltap-tags-add): add a tag to _meta/tags.yaml and commit
- [`doltap tags remove`](#doltap-tags-remove): remove a tag that no page uses
- [`doltap add`](#doltap-add): create a page (id = &lt;category&gt;/&lt;slug&gt;)
- [`doltap patch`](#doltap-patch): replace or append one ## section of a page
- [`doltap meta`](#doltap-meta): update frontmatter
- [`doltap verify`](#doltap-verify): promote draft -&gt; verified with evidence (the session that created the page cannot verify it)
- [`doltap deprecate`](#doltap-deprecate): mark a page deprecated and point to its replacement (sets replaced_by, adds a banner, updates the hub)
- [`doltap resolve`](#doltap-resolve): finish a conflict
- [`doltap history`](#doltap-history): commits that changed a page, newest first (who, when, which action, note)
- [`doltap related`](#doltap-related): outlinks, backlinks, and pages sharing tags
- [`doltap lint`](#doltap-lint): validate pages (exit 1 on errors)
- [`doltap sync`](#doltap-sync): pull, push pending commits, reindex, refresh hub lists, report conflict files and broken pages
- [`doltap reindex`](#doltap-reindex): rebuild the local search index and _meta/index.md
- [`doltap assets`](#doltap-assets): attachments under wiki/_assets/&lt;page id&gt;/
- [`doltap assets list`](#doltap-assets-list): list attachments with the pages that link them (orphans flagged)
- [`doltap assets add`](#doltap-assets-add): copy a file into wiki/_assets/&lt;id&gt;/, commit it, and print the markdown link to paste into the page
- [`doltap audit`](#doltap-audit): report unreviewed, unreferenced, lingering-draft, orphan and deprecated-but-linked pages (uses stats from all hosts)
- [`doltap golden`](#doltap-golden): run the golden query set (default wiki/_meta/golden.json
- [`doltap doctor`](#doltap-doctor): run every health check of the maintenance routine (repo, sync age, services, lint, tags, index, secrets, logs, integration)
- [`doltap upgrade`](#doltap-upgrade): compare this wiki with the skeleton shipped in this version
- [`doltap schedule`](#doltap-schedule): periodic `doltap sync` via launchd (macOS) or crontab
- [`doltap schedule install`](#doltap-schedule-install): install the periodic sync for this wiki (launchd, Task Scheduler or crontab)
- [`doltap schedule uninstall`](#doltap-schedule-uninstall): remove this wiki's periodic sync job (and a pre-0.10 global one)
- [`doltap schedule status`](#doltap-schedule-status): whether the periodic sync job is installed and loaded, and its interval
- [`doltap serve`](#doltap-serve): always-on HTTP MCP server for remote clients (claude.ai connectors, other machines)
- [`doltap serve install`](#doltap-serve-install): install and (re)start the always-on HTTP MCP service for this wiki (macOS launchd
- [`doltap serve uninstall`](#doltap-serve-uninstall): stop and remove this wiki's HTTP service (and a pre-0.10 global one)
- [`doltap serve status`](#doltap-serve-status): whether the HTTP service is installed and running, with its pid, host and port
- [`doltap serve token`](#doltap-serve-token): print the secret path token (rotate with --rotate
- [`doltap serve calls`](#doltap-serve-calls): who called which tool over HTTP, from &lt;state dir&gt;/logs/http-calls.log (no arguments or tokens are logged)
- [`doltap serve client`](#doltap-serve-client): named tokens for remote clients
- [`doltap serve client add`](#doltap-serve-client-add): create a token for a client and print it (pipe it to the clipboard
- [`doltap serve client list`](#doltap-serve-client-list): named clients with access level, creation and expiry
- [`doltap serve client extend`](#doltap-serve-client-extend): set a new expiry for a client token (the token itself stays)
- [`doltap serve client remove`](#doltap-serve-client-remove): revoke a client token
- [`doltap integrations`](#doltap-integrations): install the skill, global instruction and MCP registration for an agent client
- [`doltap integrations install`](#doltap-integrations-install): supported clients
- [`doltap integrations status`](#doltap-integrations-status): report whether the installed skill, instruction section and MCP registration match this version
- [`doltap integrations uninstall`](#doltap-integrations-uninstall): remove the skill and the MCP registration (instruction sections are left for you to delete)

### `doltap init`

set up a wiki on this machine: clone an existing wiki repository (--repo) or create a new one (--new)

| Option | Required | Default | Description |
|---|---|---|---|
| `--repo <url>` | no |  | git URL of an existing wiki repository to clone |
| `--new` | no |  | create a new wiki (protocol, templates, hubs, Obsidian config) and git init it |
| `--remote <url>` | no |  | with --new: add this empty repository as origin and push |
| `--dir <path>` | no |  | where to clone or create (default: ~/.doltap) |
| `--force` | no |  | with --new: set up inside a directory that already has files (its .gitignore is merged, only the skeleton is committed) |

### `doltap search <query...>`

full-text search (title/summary/tags weighted above body)

| Argument | Required | Default | Description |
|---|---|---|---|
| `query...` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `-c, --category <cat>` | no |  | one of howto\|patterns\|reference\|decisions\|projects |
| `-t, --tag <tag>` | no |  |  |
| `--confidence <level>` | no |  | draft\|verified\|deprecated |
| `-n, --limit <n>` | no | `"10"` | max results |
| `--include-deprecated` | no |  |  |
| `--include-hubs` | no |  | also return Home and &lt;category&gt;/_index pages |

### `doltap get <id>`

print a page (or one section) by id, e.g. howto/deploy-pypi

| Argument | Required | Default | Description |
|---|---|---|---|
| `id` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `-s, --section <heading>` | no |  | only this ## section |
| `--meta` | no |  | include frontmatter in human output |

### `doltap list`

list pages

| Option | Required | Default | Description |
|---|---|---|---|
| `-c, --category <cat>` | no |  |  |
| `-t, --tag <tag>` | no |  |  |
| `--confidence <level>` | no |  |  |
| `--include-deprecated` | no |  |  |

### `doltap index`

print the generated one-line-per-page index

### `doltap protocol`

print _meta/PROTOCOL.md

### `doltap template <category>`

print the page template for a category with today's date filled in

| Argument | Required | Default | Description |
|---|---|---|---|
| `category` | yes |  |  |

### `doltap tags`

tag vocabulary: list (default), add, remove

Subcommands: `list`, `add`, `remove`.

### `doltap tags list`

print the tag vocabulary with descriptions and usage counts

### `doltap tags add <tag> <description...>`

add a tag to _meta/tags.yaml and commit

| Argument | Required | Default | Description |
|---|---|---|---|
| `tag` | yes |  |  |
| `description...` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `--group <group>` | no |  | group heading (default other) |

### `doltap tags remove <tag>`

remove a tag that no page uses

| Argument | Required | Default | Description |
|---|---|---|---|
| `tag` | yes |  |  |

### `doltap add <id>`

create a page (id = &lt;category&gt;/&lt;slug&gt;). Body from --file/--stdin or the template.

| Argument | Required | Default | Description |
|---|---|---|---|
| `id` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `--title <text>` | yes |  |  |
| `--summary <text>` | yes |  | 1-2 sentences, max 200 chars |
| `--tags <list>` | no |  | comma-separated, must exist in _meta/tags.yaml |
| `--sources <list>` | no |  | comma-separated URLs/ids |
| `-f, --file <path>` | no |  | markdown body file |
| `--stdin` | no |  | read body from stdin |
| `--force` | no |  | create even if similar pages exist |
| `--replace` | no |  | overwrite an existing page (otherwise an existing id is refused; use patch/meta to edit) |
| `--review-by <days|date>` | no |  | when to re-check the page against its sources (howto/reference pages that depend on versions or external services) |
| `--base-rev <rev>` | no |  | rev shown by `doltap get`; refused if the page changed since |

### `doltap patch <id>`

replace or append one ## section of a page

| Argument | Required | Default | Description |
|---|---|---|---|
| `id` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `-s, --section <heading>` | yes |  |  |
| `--content <text>` | no |  |  |
| `-f, --file <path>` | no |  |  |
| `--stdin` | no |  |  |
| `--append` | no |  | append to the section instead of replacing |
| `--no-touch` | no |  | do not bump the updated date (typo fixes) |
| `--create` | no |  | add the section when the heading does not exist |
| `--base-rev <rev>` | no |  | rev shown by `doltap get`; refused if the page changed since |

### `doltap meta <id>`

update frontmatter: --add-source, --add-tag, --title, --summary (promote with `doltap verify`, deprecate with `doltap deprecate`)

| Argument | Required | Default | Description |
|---|---|---|---|
| `id` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `--confidence <level>` | no |  | draft (demote); verified needs `doltap verify`, deprecated needs `doltap deprecate` |
| `--add-source <s>` | no | `[]` | repeatable |
| `--add-tag <t>` | no | `[]` | repeatable |
| `--title <text>` | no |  |  |
| `--summary <text>` | no |  |  |
| `--review-by <days|date|none>` | no |  | when to re-check the page against its sources (howto/reference); none clears it |
| `--base-rev <rev>` | no |  | rev shown by `doltap get`; refused if the page changed since |

### `doltap verify <id>`

promote draft -&gt; verified with evidence (the session that created the page cannot verify it); on a verified page, record a re-check: verified_on and review_by move, the body and updated do not

| Argument | Required | Default | Description |
|---|---|---|---|
| `id` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `--evidence <text>` | yes |  | what you did, where, and what confirmed it; appended to sources |
| `--review-by <days|date|none>` | no |  | next re-check deadline; on a re-check without it the previous interval is kept |
| `--base-rev <rev>` | no |  |  |

### `doltap deprecate <id>`

mark a page deprecated and point to its replacement (sets replaced_by, adds a banner, updates the hub)

| Argument | Required | Default | Description |
|---|---|---|---|
| `id` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `--replaced-by <id>` | yes |  | the page to use instead (must exist) |
| `--reason <text>` | no |  |  |
| `--base-rev <rev>` | no |  |  |

### `doltap resolve <id>`

finish a conflict: write the merged body (--file/--stdin) or keep the conflict copy (--take conflict), delete the copies, commit

| Argument | Required | Default | Description |
|---|---|---|---|
| `id` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `-f, --file <path>` | no |  | merged body file |
| `--stdin` | no |  |  |
| `--take <which>` | no |  | conflict: use the conflict copy's body as is |
| `--base-rev <rev>` | no |  | rev shown by `doltap get`; refused if the page changed since |

### `doltap history <id>`

commits that changed a page, newest first (who, when, which action, note)

| Argument | Required | Default | Description |
|---|---|---|---|
| `id` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `-n, --limit <n>` | no | `"20"` | entries |

### `doltap related <id>`

outlinks, backlinks, and pages sharing tags

| Argument | Required | Default | Description |
|---|---|---|---|
| `id` | yes |  |  |

### `doltap lint [ids...]`

validate pages (exit 1 on errors)

| Argument | Required | Default | Description |
|---|---|---|---|
| `ids...` | no |  |  |

### `doltap sync`

pull, push pending commits, reindex, refresh hub lists, report conflict files and broken pages

### `doltap reindex`

rebuild the local search index and _meta/index.md

| Option | Required | Default | Description |
|---|---|---|---|
| `--full` | no |  |  |

### `doltap assets`

attachments under wiki/_assets/&lt;page id&gt;/: list (default), add

Subcommands: `list`, `add`.

### `doltap assets list`

list attachments with the pages that link them (orphans flagged)

### `doltap assets add <id> <file>`

copy a file into wiki/_assets/&lt;id&gt;/, commit it, and print the markdown link to paste into the page

| Argument | Required | Default | Description |
|---|---|---|---|
| `id` | yes |  |  |
| `file` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `--force` | no |  | allow a file over the size cap or of an unlisted type |

### `doltap audit`

report unreviewed, unreferenced, lingering-draft, orphan and deprecated-but-linked pages (uses stats from all hosts); decisions/ and projects/ never age

| Option | Required | Default | Description |
|---|---|---|---|
| `--unreferenced-days <n>` | no | `"90"` | no reads within N days (howto, patterns, reference) |
| `--review-days <n>` | no |  | override the per-category review window for pages without review_by (reference 180, howto 365) |
| `--draft-days <n>` | no | `"30"` | draft created more than N days ago |
| `--report` | no |  | also write the report to wiki/_meta/reports/&lt;date&gt;.md and commit it (the weekly pass reads it) |
| `--keep <n>` | no | `"12"` | with --report: how many dated reports to keep |

### `doltap golden [file]`

run the golden query set (default wiki/_meta/golden.json: [{query, expect}]) and list queries whose page is not first; exit 1 on misses

| Argument | Required | Default | Description |
|---|---|---|---|
| `file` | no |  |  |

### `doltap doctor`

run every health check of the maintenance routine (repo, sync age, services, lint, tags, index, secrets, logs, integration); exit 1 on failures

| Option | Required | Default | Description |
|---|---|---|---|
| `--healthz <url>` | no |  | also probe a public /healthz URL (no token in it) |
| `--no-services` | no |  | skip the scheduler and HTTP service checks |
| `--quiet` | no |  | print only warnings and failures |

### `doltap upgrade`

compare this wiki with the skeleton shipped in this version; --apply merges .gitignore/.gitattributes lines and replaces Obsidian config and templates, PROTOCOL changes are shown for manual merge

| Option | Required | Default | Description |
|---|---|---|---|
| `--diff` | no |  | print unified diffs for differing files |
| `--apply` | no |  | write the applicable changes and commit them |

### `doltap schedule`

periodic `doltap sync` via launchd (macOS) or crontab

Subcommands: `install`, `uninstall`, `status`.

### `doltap schedule install`

install the periodic sync for this wiki (launchd, Task Scheduler or crontab); re-run after a Node or doltap upgrade

| Option | Required | Default | Description |
|---|---|---|---|
| `--every <minutes>` | no | `"10"` | interval (under 60, or a multiple of 60) |

### `doltap schedule uninstall`

remove this wiki's periodic sync job (and a pre-0.10 global one)

### `doltap schedule status`

whether the periodic sync job is installed and loaded, and its interval

### `doltap serve`

always-on HTTP MCP server for remote clients (claude.ai connectors, other machines)

Subcommands: `install`, `uninstall`, `status`, `token`, `calls`, `client`.

### `doltap serve install`

install and (re)start the always-on HTTP MCP service for this wiki (macOS launchd; other platforms get the command to run)

| Option | Required | Default | Description |
|---|---|---|---|
| `--port <n>` | no | `"8765"` | listen port |
| `--host <h>` | no | `"127.0.0.1"` | bind address |
| `--show-url` | no |  | print the local URL including the secret token |

### `doltap serve uninstall`

stop and remove this wiki's HTTP service (and a pre-0.10 global one)

### `doltap serve status`

whether the HTTP service is installed and running, with its pid, host and port

### `doltap serve token`

print the secret path token (rotate with --rotate: a running service picks the new one up within seconds and the old one stops working; then re-register remote clients)

| Option | Required | Default | Description |
|---|---|---|---|
| `--rotate` | no |  |  |
| `--quiet` | no |  | do not print the token (use with --rotate in scripts and agent sessions) |

### `doltap serve calls`

who called which tool over HTTP, from &lt;state dir&gt;/logs/http-calls.log (no arguments or tokens are logged)

| Option | Required | Default | Description |
|---|---|---|---|
| `--since <days>` | no | `"7"` | window in days |
| `-n, --limit <n>` | no | `"20"` | recent lines to print |

### `doltap serve client`

named tokens for remote clients: commits carry the name, --read-only tokens cannot write

Subcommands: `add`, `list`, `extend`, `remove`.

### `doltap serve client add <name>`

create a token for a client and print it (pipe it to the clipboard; it is not shown again)

| Argument | Required | Default | Description |
|---|---|---|---|
| `name` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `--read-only` | no |  |  |
| `--expires <days|date>` | no |  | last day the token works: days from today or YYYY-MM-DD (default: never) |

### `doltap serve client list`

named clients with access level, creation and expiry

### `doltap serve client extend <name>`

set a new expiry for a client token (the token itself stays)

| Argument | Required | Default | Description |
|---|---|---|---|
| `name` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `--expires <days|date>` | yes |  | days from today or YYYY-MM-DD; "never" removes the expiry |

### `doltap serve client remove <name>`

revoke a client token; the running service stops accepting it at once

| Argument | Required | Default | Description |
|---|---|---|---|
| `name` | yes |  |  |

### `doltap integrations`

install the skill, global instruction and MCP registration for an agent client

Subcommands: `install`, `status`, `uninstall`.

### `doltap integrations install <client>`

supported clients: claude, codex, cursor, gemini, generic (claude = Claude Code via its CLI; codex, cursor, gemini = their user-level config file; generic = print JSON for any other MCP client)

| Argument | Required | Default | Description |
|---|---|---|---|
| `client` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `--remote [url]` | no |  | register the always-on HTTPS endpoint instead of the local stdio server; omit the value to read it from $DOLTAP_REMOTE_URL (keeps the token out of shell history) |
| `--dry-run` | no |  | print what would change without writing anything |
| `--show-url` | no |  | with generic: print the remote URL unmasked |
| `--name <server>` | no | `"doltap"` | MCP server name in Claude Code (claude only); use another name to register a second wiki, e.g. --root ~/team-wiki --name doltap-team |

### `doltap integrations status`

report whether the installed skill, instruction section and MCP registration match this version

### `doltap integrations uninstall <client>`

remove the skill and the MCP registration (instruction sections are left for you to delete)

| Argument | Required | Default | Description |
|---|---|---|---|
| `client` | yes |  |  |

| Option | Required | Default | Description |
|---|---|---|---|
| `--name <server>` | no | `"doltap"` | MCP server name to remove (claude only); with a non-default name the shared skill stays |

