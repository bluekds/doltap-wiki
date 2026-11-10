#!/usr/bin/env bash
# Build the public sample wiki behind demo.html and print every command's real output.
#   ./demo-wiki.sh [dir]     (default: out/demo-wiki; removed and recreated)
#   SEED_ONLY=1 ./demo-wiki.sh [dir]   stop after the seed pages and the server clone (agent-demo.sh starts from here)
# Two clones ("laptop", "server") of one bare remote, three generic seed pages, then the demo's story:
# search on laptop, record the fix in a section, sync and search on server. Nothing here comes from a real wiki.
set -euo pipefail
cd "$(dirname "$0")"
D=$(mkdir -p "${1:-out/demo-wiki}" && cd "${1:-out/demo-wiki}" && pwd); rm -rf "$D"/*; mkdir -p "$D/pages"
export GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.com GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.com
git init -q --bare -b main "$D/remote.git"
DOLTAP_STATE_HOME="$D/state-laptop" doltap init --new --dir "$D/laptop" --remote "$D/remote.git" >/dev/null
git -C "$D/laptop" config user.name demo; git -C "$D/laptop" config user.email demo@example.com

cat > "$D/pages/npm.md" <<'MD'
## Prerequisites

- npm account with publish rights on every package in the workspace
- GitHub repository with Actions enabled

## Steps

1. Bump the version in every workspace `package.json` and the lockfile.
2. Merge to `main`, then tag: `git tag v1.2.3 && git push origin v1.2.3`.
3. The Publish workflow runs the tests and publishes each package with `--provenance`.

## Verification

- `npm view <package> version` shows the new version.
- The package page on npmjs.com shows the provenance badge.

## Pitfalls

- Publish dependencies first (core, then the packages that pin it), or a clean install fails for a minute.

## Related

- [[howto/_index]]
MD
cat > "$D/pages/retry.md" <<'MD'
## Problem

Calls to a remote (git push, an HTTP API) fail transiently; retrying at once hammers a service that is already down.

## Solution

Retry with exponential backoff and jitter, cap the attempts, and remember the last failure so the next caller backs off too.

## Variations

- Fixed retry count for user-facing commands; unbounded with a cap for background jobs.

## Anti-patterns

- Retrying non-idempotent writes without a key.

## Used in

- background push, auto-pull

## Related

- [[patterns/_index]]
MD
cat > "$D/pages/node.md" <<'MD'
## Key facts

- Supported: Node.js 22.13 and later (LTS lines only).
- `node:sqlite` is used for the search index; it needs 22.13+.

## Details

Odd-numbered releases are not tested.

## Verified on

- macOS 15, Ubuntu 24.04, Windows 11

## Related

- [[reference/_index]]
MD
cat > "$D/pages/pitfall.md" <<'MD'
- Publish dependencies first (core, then the packages that pin it), or a clean install fails for a minute.
- First trusted publish fails with 403 "OIDC permission denied": on npmjs.com, open the package's trusted publisher and tick "Allow npm publish", then re-run the failed job.
MD

laptop() { DOLTAP_STATE_HOME="$D/state-laptop" DOLTAP_AGENT=claude-code DOLTAP_SESSION="${S:-demo-laptop}" doltap --root "$D/laptop" "$@"; }
server() { DOLTAP_STATE_HOME="$D/state-server" DOLTAP_AGENT=codex DOLTAP_SESSION=demo-server doltap --root "$D/server" "$@"; }
S=demo-seed laptop add howto/release-npm-packages --title "Release npm packages with trusted publishing" --summary "Tag v<version> on main; the Publish workflow tests and publishes every workspace package with provenance, no npm token." --tags release,ci,github -f "$D/pages/npm.md" >/dev/null
S=demo-seed laptop add patterns/retry-with-backoff --title "Retry with backoff" --summary "Retry transient remote failures with exponential backoff, jitter and a cap; remember the last failure so others back off." --tags networking,performance -f "$D/pages/retry.md" >/dev/null
S=demo-seed laptop add reference/node-version-support --title "Node.js version support" --summary "Node 22.13+ LTS is supported (node:sqlite); odd releases are not tested." --tags typescript,tooling -f "$D/pages/node.md" >/dev/null
DOLTAP_STATE_HOME="$D/state-server" doltap init --repo "$D/remote.git" --dir "$D/server" >/dev/null
git -C "$D/server" config user.name demo; git -C "$D/server" config user.email demo@example.com
[ -n "${SEED_ONLY:-}" ] && exit 0

echo '== laptop $ doltap search "npm publish 403 OIDC"'; laptop search "npm publish 403 OIDC"
echo '== laptop $ doltap patch howto/release-npm-packages -s Pitfalls -f fix.md'; laptop patch howto/release-npm-packages -s Pitfalls -f "$D/pages/pitfall.md"
echo '== laptop commit trailer'; git -C "$D/laptop" log -1 --format=%b | head -1
echo '== server $ doltap sync'; server sync
echo '== server $ doltap search "npm publish 403 OIDC"'; server search "npm publish 403 OIDC"
echo '== server $ doltap get howto/release-npm-packages -s Pitfalls'; server get howto/release-npm-packages -s Pitfalls
