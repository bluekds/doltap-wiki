---
title: OpenRouter API
category: reference
summary: >-
  OpenRouter endpoints, key check, cost fields, provider routing and the data_collection setting.
tags:
  - llm
  - api
confidence: verified
created: 2026-09-15
updated: 2026-10-10
sources: []
---
## Facts

- Base `https://openrouter.ai/api/v1`; `GET /auth/key` checks the key.
- `usage.cost` is returned when `usage: {include: true}`.
- `provider.data_collection: deny` keeps prompts out of training.
