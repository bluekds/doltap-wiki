---
title: Retry with exponential backoff
category: patterns
summary: >-
  Retry a transient failure a bounded number of times with exponential delay and jitter; give up on permanent errors.
tags:
  - reliability
confidence: verified
created: 2026-08-01
updated: 2026-08-01
sources: []
---
## When

Network calls that fail transiently (timeouts, 429, 503).

## Pattern

Delay 1s, 2s, 4s with jitter; at most 5 attempts; never retry 4xx except 429.

## Anti-pattern

Unbounded retry loops without jitter hammer the server in lockstep.
