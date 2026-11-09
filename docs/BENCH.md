# Scale check

How the index, search and lint behave at five thousand pages. Reproduce with

```
cd packages/core
DOLTAP_BENCH=1 npx vitest run test/bench.test.ts --testTimeout=600000
# DOLTAP_BENCH_PAGES=<n> for another size; DOLTAP_BENCH_OUT=<file> writes the rows as JSON
```

The test generates synthetic pages (four categories, template-shaped bodies, twenty shared words so searches hit) in a throwaway wiki, then measures each step. It is skipped unless `DOLTAP_BENCH=1`, so CI does not run it.

## 2026-11-03, doltap 0.8.0

Apple M4 Mac mini, macOS, Node v24.22.1, SQLite via `node:sqlite`, APFS. Measured while other sessions were running on the machine, so treat the numbers as upper bounds.

| Step | Result (5000 pages) |
|---|---|
| generate pages | 464 ms |
| full reindex | 2967 ms (5011 pages) |
| no-op reindex (per request) | 415 ms (0 re-parsed) |
| incremental reindex (10 changed) | 400 ms (10 re-parsed) |
| search p50 / p95 | 2.7 / 7.6 ms (223 hits over 40 queries) |
| lintAll | 659 ms (6667 issues) |

## 2026-11-03, doltap 0.9.0 (unreleased): reindex parses only changed files

Same machine, under heavier load than the 0.8.0 run (full reindex, whose code did not change, took 3.4 s and 4.3 s in two runs), so compare the no-op and incremental rows with the row above rather than across the table.

| Step | Result (5000 pages) |
|---|---|
| generate pages | 364 ms |
| full reindex | 3393 ms (5011 pages) |
| no-op reindex (per request) | 56 ms (0 re-parsed) |
| incremental reindex (10 changed) | 84 ms (10 re-parsed) |
| search p50 / p95 | 4.2 / 12.9 ms (223 hits over 40 queries) |
| lintAll | 1024 ms (6667 issues) |

## 2026-11-09, doltap 0.12.0: one bm25-ranked pool, rarity-weighted coverage

Same machine. Search now counts each query term's document frequency (one FTS count per term) and checks which terms every candidate contains; the cost does not show at this size. Full reindex is much faster than in the 0.9.0 run since 0.9.1 deletes FTS rows by rowid instead of scanning.

| Step | Result (5000 pages) |
|---|---|
| generate pages | 507 ms |
| full reindex | 527 ms (5011 pages) |
| no-op reindex (per request) | (per request)          31 ms (0 re-parsed) |
| incremental reindex (10 changed) | (10 changed)     33 ms (10 re-parsed) |
| search p50 / p95 | 6.9 / 12.8 ms (220 hits over 40 queries) |
| lintAll | 425 ms (6667 issues) |

## Reading the numbers

- **Full reindex** parses every page once. It happens on `doltap reindex`, on a schema change, or on a fresh clone; a few seconds for five thousand pages is fine.
- **No-op reindex** is what every read pays: the index `stat()`s every page file to see whether anything changed. Until 0.8.0 it also read and parsed every page before comparing, which is where the 400 ms went; since 0.9.0 unchanged pages are not opened, and five thousand stats cost about 60 ms. The next step, if wikis grow well past this size, would be a directory-mtime shortcut or a watcher; below a thousand pages the cost is in the single digits of milliseconds.
- **Incremental reindex** re-parses only the changed files on top of the no-op cost.
- **Search** is FTS5 with a small ranking pass; latency does not depend much on wiki size at this scale.
- **lintAll** reads every page once more; it runs on `doltap lint`, `doltap doctor` and the weekly pass, not on every call.
