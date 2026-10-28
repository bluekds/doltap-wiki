---
title: Demo wiki deployment
category: projects
summary: >-
  Where this wiki runs: the always-on host, its launchd services, the Tailscale Funnel endpoint, token file location and log paths.
tags:
  - wiki
  - ops
confidence: verified
created: 2026-09-01
updated: 2026-10-26
sources: []
---
## Environment

- Host: an always-on Mac mini; wiki at `~/.doltap`.
- launchd: `com.doltap.sync` every 10 min, `com.doltap.mcp` on 127.0.0.1:8765.
- Public endpoint: Tailscale Funnel `https://<node>.<tailnet>.ts.net`; token in `.doltap/http-token`.
- Logs: `.doltap/logs/`.

## Related

- [[howto/expose-mcp-tailscale-funnel]]
- [[howto/restart-launchd-service]]
