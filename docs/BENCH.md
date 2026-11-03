# Scale check

How the index, search and lint behave at five thousand pages. Reproduce with

```
cd packages/core
DOLTAP_BENCH=1 npx vitest run test/bench.test.ts --testTimeout=600000
# DOLTAP_BENCH_PAGES=<n> for another size; DOLTAP_BENCH_OUT=<file> writes the rows as JSON
```

The test generates synthetic pages (four categories, template-shaped bodies, twenty shared words so searches hit) in a throwaway wiki, then measures each step. It is skipped unless `DOLTAP_BENCH=1`, so CI does not run it.

## 2026-11-03, doltap 0.8.0

Apple M4 Mac mini, macOS, Node v24.22.1, SQLite via better-sqlite3, APFS. Measured while other sessions were running on the machine, so treat the numbers as upper bounds.

| Step | Result (5000 pages) |
|---|---|
| generate pages | 464 ms |
| full reindex | 2967 ms (5011 pages) |
| no-op reindex (per request) | 415 ms (0 re-parsed) |
| incremental reindex (10 changed) | 400 ms (10 re-parsed) |
| search p50 / p95 | 2.7 / 7.6 ms (223 hits over 40 queries) |
| lintAll | 659 ms (6667 issues) |

## Reading the numbers

- **Full reindex** parses every page once. It happens on `doltap reindex`, on a schema change, or on a fresh clone; a few seconds for five thousand pages is fine.
- **No-op reindex** is what every read pays: the index `stat()`s every page file to see whether anything changed. At five thousand pages that is a few hundred milliseconds per MCP call, which is where the next optimisation would go (a directory mtime shortcut or a watcher) if wikis grow past this size. Below a thousand pages it is a few tens of milliseconds.
- **Incremental reindex** re-parses only the changed files on top of the no-op cost.
- **Search** is FTS5 with a small ranking pass; latency does not depend much on wiki size at this scale.
- **lintAll** reads every page once more; it runs on `doltap lint`, `doltap doctor` and the weekly pass, not on every call.
