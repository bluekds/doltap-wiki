---
title: Maintain the wiki (routine for a maintainer agent)
category: howto
summary: >-
  Session-start, weekly, monthly and event-driven checks that keep the wiki
  healthy, plus prompt templates for running them from a scheduled agent session.
tags:
  - wiki
  - tooling
confidence: draft
created: 2026-10-18
updated: 2026-10-28
sources: []
---
## Prerequisites

- One agent (one Claude Code session, usually on the always-on machine) is named the maintainer. Other agents keep writing pages freely; the maintainer keeps quality up.
- The maintainer follows [[_meta/PROTOCOL]]; this page only adds the schedule and the limits of its authority.
- `doltap` is installed and the wiki is cloned on that machine ([[howto/setup-wiki-on-new-machine]]).

## Steps

### Every maintenance session (start)

1. `doltap sync` and read its output: `pulled: true`, no conflict files
2. `doltap doctor` reports 0 failures (it checks the scheduler, the HTTP service and `/healthz`, the last pull, lint, tags, index, token files, logs and the installed skill); each warning names the command that clears it. Fix failures before anything else
3. `doltap lint` reports 0 errors (also part of doctor; run it alone to see every issue)

### Weekly

1. Review pages added or changed in the last week: `git log --since="1 week ago" --format='%h %s' -- wiki/`, then `doltap get` each. Check category fit, a summary that stands on its own, sensible tags, links to related pages, no secrets, no session-log content. Fix with `doltap patch` / `doltap meta`
2. `doltap audit`: for each lingering draft decide promote / leave / propose deprecation. Promote only with evidence (someone followed the page and it worked): `doltap verify <id> --evidence "<what confirmed it>"`; deprecate with `doltap deprecate <id> --replaced-by <new-id>`
3. Check that every category hub's "Manual list" matches the pages on disk
4. `doltap audit` also lists search misses (queries where the page opened next was not the first hit): reword the title or summary of the page that should have won, or add the missing page. Then `doltap golden` (`wiki/_meta/golden.json`, `[{query, expect}]`); add a query to the set when a miss is fixed so it stays fixed
5. Look at `wiki/_meta/stats/*.json`: a machine that stopped reporting usually has a broken scheduler

### Monthly

1. Re-verify `reference/` pages about external services whose "Verified on" date is older than ~60 days; update or record what changed
2. From `doltap audit`, propose deprecating pages nobody read or updated in 90 days (except rare-but-critical procedures)
3. Update the tooling: `npm install -g doltap-wiki@latest`, then re-run `doltap schedule install` (and `doltap serve install` if used) so the services pick up the new binary; then `doltap upgrade` and apply the shipped config and template changes with `--apply`, merging any `PROTOCOL.md` diff by hand
4. `doltap integrations status` on each machine with Claude Code: a stale skill copy means `doltap integrations install claude` again
5. Tag vocabulary: `doltap audit` lists unused tags; `doltap tags remove <tag>` drops one, `doltap tags add <tag> <description> --group <g>` adds the ones agents keep needing

### Event-driven

- A `*.conflict-<host>.md` file appears: merge both versions, then `doltap resolve <id> --file merged.md` (or `--take conflict` to keep the copy); it deletes the copy and commits. When the page itself is gone (deleted upstream), `--take conflict` restores it from the copy
- `doltap history <id>` shows who changed a page and when, with the evidence recorded at verification; use it before questioning or rewriting someone's page
- `doltap lint` reports a `symlink` error: someone committed a symbolic link under `wiki/`; it is never read, but remove it (`git rm`) and check who pushed it (`git log -- <path>`)
- A machine reports a stuck repository: see [[howto/setup-wiki-on-new-machine#Pitfalls]]
- The HTTP token was exposed (chat, log, screenshot): `doltap serve token --rotate --quiet && doltap serve install` (neither prints the token), then update every remote registration. A named client token that leaked: `doltap serve client remove <name>` and issue a new one; give new tokens an `--expires`
- `doltap doctor` warns that a client token expires within a week: `doltap serve client extend <name> --expires <days>`, or remove the client if it is gone. `doltap serve calls --since 30` shows which clients still call

### Running it from a scheduled agent session

Claude Code can schedule prompts inside a long-running session. Open a session on the maintainer machine and ask for two recurring jobs with prompts like these (replace `<wiki-root>`):

> Daily, 09:07: In `<wiki-root>` run the session-start checks from `doltap get howto/maintain-doltap-wiki -s Steps`. Fix only mechanical problems (restart a stopped service, obvious lint fixes, a page missing from its hub list). Never print the HTTP token. Report in at most 3 lines when everything is fine.

> Weekly, Monday 09:13: In `<wiki-root>` follow the Weekly steps of `doltap get howto/maintain-doltap-wiki -s Steps`; on the 1st–7th of the month also the Monthly steps. Allowed without asking: safe fixes and promoting drafts with evidence. Not allowed without approval: deprecating, deleting or merging pages; list those as proposals. Finally re-create both scheduled jobs, because in-session jobs expire after 7 days.

Session-scheduled jobs live only while that session is open; if it ends, open a new one and ask for the jobs again. Set `DOLTAP_AGENT` for that session so commits show who made them.

## Verification

- Session-start checks all green; `doltap lint` 0 errors
- After the weekly pass: no draft older than 30 days without a recorded decision, no conflict files, every page reachable from its hub
- After the monthly pass: tooling current, external `reference/` pages verified within ~60 days

## Pitfalls

- The scheduler entries record a Node binary path. Homebrew installs get a stable alias (`/opt/homebrew/opt/node@<major>/bin/node`), but a switch to another major version or an nvm keg still changes it, and then the scheduled sync and HTTP service stop silently: re-run `doltap schedule install` (and `doltap serve install` if used), then check `.doltap/logs/sync.err`
- The maintainer does not run on its own. Without a scheduled session or a user request, the weekly and monthly passes never happen
- Do not promote a draft because it looks right; promotion needs evidence that someone followed it and it worked
- Never paste the HTTP token or full connector URL into chat or a page while debugging the remote endpoint
- Hub pages and `_meta/` are excluded from orphan checks; a page linked only from a hub is fine

## Related

- [[howto/_index]]
- [[howto/setup-wiki-on-new-machine]]
- [[howto/add-wiki-page-manually]]
