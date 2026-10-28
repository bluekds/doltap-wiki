---
title: SQLite FTS5 notes
category: reference
summary: >-
  Facts about the FTS5 index used by the wiki: tokenizer, bm25 column weights, prefix queries, snippet function, and what reindex does.
tags:
  - tooling
  - sqlite
confidence: verified
created: 2026-08-10
updated: 2026-09-30
sources: []
---
## Facts

- Tokenizer `porter unicode61`: stemmed English, any script split on non-letters.
- `bm25(pages_fts, 0, 10, 6, 4, 1)` weights title, summary, tags, body; lower is better.
- Prefix terms `"tok"*` match stems; a query is implicit AND.
- `snippet()` returns the matched region of the body.
- Ranking beyond bm25 (confidence, recency) is applied after the query.
