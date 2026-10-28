---
title: Rotate the HTTP token
category: howto
summary: >-
  Replace the doltap HTTP path token after a leak or on schedule, restart the service and update every connector.
tags:
  - wiki
  - security
  - ops
confidence: verified
created: 2026-09-01
updated: 2026-10-20
sources: []
---
## Prerequisites

- Shell access to the host that runs the HTTP service.

## Steps

1. `doltap serve token --rotate` writes a new token file (mode 600) and prints nothing secret.
2. `doltap serve install` restarts the service with the new path.
3. Update the connector URL in claude.ai and on every laptop; the old URL answers 404 from now on.

## Verification

`doltap doctor` reports secrets ok and the public healthz answers.

## Pitfalls

- A token pasted into chat or a log is leaked: rotate immediately, do not wait for the schedule.

## Related

- [[howto/expose-mcp-tailscale-funnel]]
