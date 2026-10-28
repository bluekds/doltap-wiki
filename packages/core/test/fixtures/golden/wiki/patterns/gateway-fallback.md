---
title: LLM gateway fallback
category: patterns
summary: >-
  Send a model request to a primary gateway, fall back to a second gateway once on failure, then to a local model.
tags:
  - llm
  - reliability
confidence: draft
created: 2026-10-05
updated: 2026-10-05
sources: []
---
## When

A single LLM gateway has outages or rate limits.

## Pattern

Primary gateway, then secondary gateway, then local; log which one answered.

## Related

- [[patterns/retry-with-backoff]]
- [[reference/openrouter-api]]
