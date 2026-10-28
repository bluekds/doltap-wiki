---
title: Resolve a sync conflict
category: howto
summary: >-
  When two machines edited the same page, sync keeps a conflict copy; merge it into the page and remove the copy with doltap resolve.
tags:
  - wiki
  - git
confidence: verified
created: 2026-09-05
updated: 2026-10-01
sources: []
---
## Prerequisites

- `doltap sync` reported a conflict, or `doltap audit` lists conflict files.

## Steps

1. `doltap get <id>` and open the conflict copy `<id>.conflict-<host>-<date>.md` side by side.
2. Merge the useful parts into the page with `doltap patch` per section.
3. `doltap resolve <id>` deletes the copy and commits.

## Verification

`doltap audit` shows no conflict files and `doltap sync` pushes cleanly.

## Pitfalls

- Never edit the conflict copy itself; it is removed on resolve.

## Related

- [[howto/weekly-maintenance-routine]]
