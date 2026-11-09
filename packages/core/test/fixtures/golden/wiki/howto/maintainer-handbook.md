---
title: Maintainer handbook
category: howto
summary: >-
  Everything the maintainer agent does, in one place: daily and weekly checks, services, tokens, releases, clients on other machines, recovery recipes.
tags:
  - wiki
  - ops
confidence: draft
created: 2026-10-27
updated: 2026-10-27
sources: []
---
## Prerequisites

- A session on the always-on host where the wiki runs. Know where the launchd services live and where the token file is.

## Steps

1. Every session: sync, then check that the launchd services run (`doltap schedule status`, `doltap serve status`), that healthz answers through the funnel, and that lint is clean. If a service does not run, reinstall it; if the funnel does not answer, check tailscale.
2. Weekly: review new pages, run the audit, check the hub lists, try three searches, see which machine reports stats. Merge conflict copies after a sync conflict.
3. Tokens: when a token leaks (chat, log, screenshot), rotate the http token at once, then update the connector on every other machine. After a leak, check the call log for requests from another machine you do not know.
4. Clients on another machine: a laptop or a server calls the wiki through the connector; it can also call the model server, the search server and the other services the host runs. Set up a new machine with the setup page, then register the connector.
5. Releases: publish to npm and deploy to pypi from the release workflow; after a release, update the services on the host and run the checks again.
6. Recovery: where a service does not start after an upgrade, read its error log, reinstall the service, and record what happened. Run the doctor after any change to the host.

## Verification

All checks green after every session; no conflict copies; every machine that calls the wiki answers with the current token.

## Pitfalls

- Doing a sync on another machine while the host writes creates a conflict; merge it before the next session.
- After a leak, an old token on another machine answers 404 until the connector is updated; that is expected, not a server failure.
- A brew upgrade can break the runtime the services run on; check the services after any upgrade.

## Related

- [[howto/weekly-maintenance-routine]]
- [[howto/rotate-http-token]]
- [[howto/setup-new-machine]]
- [[projects/demo/_index]]
