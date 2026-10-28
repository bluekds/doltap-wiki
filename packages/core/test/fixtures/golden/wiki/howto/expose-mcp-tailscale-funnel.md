---
title: Expose the MCP server with Tailscale Funnel
category: howto
summary: >-
  Publish the local HTTP MCP service over HTTPS with Tailscale Funnel so remote agents and claude.ai connectors can reach it.
tags:
  - wiki
  - network
  - ops
confidence: verified
created: 2026-08-15
updated: 2026-10-15
sources: []
---
## Prerequisites

- Tailscale installed and logged in; Funnel enabled for the tailnet.
- The HTTP service listening on 127.0.0.1:8765.

## Steps

1. `tailscale funnel --bg 8765` publishes the port on `https://<node>.<tailnet>.ts.net`.
2. `tailscale funnel status` shows the mapping.
3. Give connectors the URL with the path token; keep the token out of chat.

## Verification

`curl https://<node>.<tailnet>.ts.net/healthz` prints ok from outside the tailnet.

## Pitfalls

- Funnel only forwards HTTPS on 443, 8443 and 10000.

## Related

- [[howto/rotate-http-token]]
- [[projects/demo/_index]]
