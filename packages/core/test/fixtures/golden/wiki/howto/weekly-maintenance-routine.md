---
title: Weekly maintenance routine
category: howto
summary: >-
  Every week: sync, check services and healthz, lint, audit, merge conflict copies, rotate the token if it leaked, check npm and pypi releases, restart launchd services that stopped.
tags:
  - wiki
  - ops
confidence: draft
created: 2026-10-27
updated: 2026-10-27
sources: []
---
## Prerequisites

- A session on the always-on host.

## Steps

1. `doltap sync`; if it reports a conflict, follow [[howto/resolve-sync-conflict]]. Conflict copies left for a week block other writers, so merge the conflict first.
2. `doltap schedule status` and `doltap serve status`; if the launchd service stopped, `doltap serve install` restarts the launchd service.
3. `curl https://<node>.<tailnet>.ts.net/healthz`; if the funnel is down, `tailscale funnel status`.
4. `doltap lint` and `doltap audit`; promote drafts with evidence, propose deprecations.
5. If a token appeared in any log, rotate the token at once.
6. Check whether the npm publish and the pypi deploy of last week propagated; `npm view` and `pip index versions`.
7. Review sync, conflict, launchd, token, npm, pypi notes in the audit report and record anything new.

## Verification

Every check green; no conflict copies; no draft older than 30 days without a decision.

## Pitfalls

- Doing the sync conflict merge on the laptop while the host also writes creates a second conflict.
- Restarting the launchd service during a sync can leave a lock file.

## Related

- [[howto/resolve-sync-conflict]]
- [[howto/rotate-http-token]]
- [[howto/restart-launchd-service]]
