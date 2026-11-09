---
title: Call the self-hosted model server
category: howto
summary: >-
  Map of the self-hosted model server (LLM, speech, embedding, OCR, web search): ports, per-service keys, health checks and request examples from another host.
tags:
  - api
  - ops
confidence: draft
created: 2026-10-21
updated: 2026-10-27
sources: []
---
## Prerequisites

- Network access to the model server (LAN or tailnet) and the key for the LLM service.

## Steps

1. Pick the service: LLM on 8004 (Bearer key), speech on 8001, embedding on 8005, OCR on 8006, search on 8889.
2. Check `/health` on the port first; it never needs a key.
3. Call the LLM with an OpenAI-compatible client, `base_url` pointing at the server, the key from the environment.

## Verification

`/v1/models` lists the model; a short chat completion answers.

## Pitfalls

- From another host, use the tailnet name, not localhost.

## Related

- [[howto/_index]]
