#!/usr/bin/env bash
# Publish the three doltap packages to npm at the version in the root package.json, in dependency order:
#   @bluekds/doltap-core -> @bluekds/doltap-mcp -> doltap-wiki
# Safe to re-run: a package whose version is already on the registry is skipped, so an expired OTP
# half-way through just means "run it again".
#
#   tools/publish.sh [--otp CODE] [--dry-run] [--skip-tests] [--no-smoke] [--tag TAG]
#
# Fallback only: since 0.11 a pushed v* tag publishes through .github/workflows/publish.yml (trusted publishing).
#
# Checks before anything is uploaded: all package versions agree, the working tree is clean,
# HEAD is the v<version> tag or a later commit with packages/ unchanged (both only warnings under --dry-run), and `npm whoami` succeeds. Then build, test, publish, verify
# the registry, and do a clean install of doltap-wiki@<version> in a temp dir.
set -euo pipefail
cd "$(dirname "$0")/.."

OTP="" DRY=0 SKIP_TESTS=0 SMOKE=1 TAG="latest"
while [ $# -gt 0 ]; do
  case "$1" in
    --otp) OTP="$2"; shift 2 ;;
    --otp=*) OTP="${1#--otp=}"; shift ;;
    --dry-run) DRY=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --no-smoke) SMOKE=0; shift ;;
    --tag) TAG="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "publish: $*" >&2; exit 1; }
ver() { node -p "require('./$1/package.json').version"; }
name() { node -p "require('./$1/package.json').name"; }
on_registry() { [ -n "$(npm view "$1@$2" version 2>/dev/null)" ]; }

VERSION=$(ver .)
PKGS=(packages/core packages/mcp packages/cli)

echo "== doltap $VERSION"
for p in "${PKGS[@]}"; do
  v=$(ver "$p")
  [ "$v" = "$VERSION" ] || die "$(name "$p") is $v, root is $VERSION; bump versions first"
done
# A dry run only reports these two, so the pipeline can be rehearsed from a branch.
if [ "$DRY" = 1 ]; then guard() { echo "   warning (dry run): $*"; }; else guard() { die "$@"; }; fi
[ -z "$(git status --porcelain)" ] || guard "working tree is not clean"
# HEAD must be the tagged release, or a later commit that left what gets published exactly as tagged
# (tooling, docs or tests merged after the tag): tests are not packed, so they do not count.
if git tag --points-at HEAD | grep -qx "v$VERSION"; then
  :
elif git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null \
    && git merge-base --is-ancestor "v$VERSION" HEAD \
    && git diff --quiet "v$VERSION" HEAD -- packages package-lock.json ':!packages/*/test/*'; then
  echo "   v$VERSION is $(git rev-list --count "v$VERSION"..HEAD) commit(s) behind HEAD; published files unchanged since the tag"
else
  guard "HEAD is not tagged v$VERSION and the published files differ from the tag; finish the release (merge, tag) first"
fi
me=$(npm whoami 2>/dev/null) || die "not logged in to npm (npm login)"
echo "   logged in as $me, tag $TAG$( [ "$DRY" = 1 ] && echo ', dry run')"

echo "== build"
npm run build --silent
echo "== tool reference"
npm run reference:check --silent
if [ "$SKIP_TESTS" = 0 ]; then
  echo "== test"
  npm test --silent
fi

for p in "${PKGS[@]}"; do
  n=$(name "$p")
  if on_registry "$n" "$VERSION"; then
    echo "== $n@$VERSION already on the registry, skipping"
    continue
  fi
  echo "== publish $n@$VERSION"
  args=(publish --workspace "$p" --access public --tag "$TAG")
  [ -n "$OTP" ] && args+=(--otp "$OTP")
  [ "$DRY" = 1 ] && args+=(--dry-run)
  npm "${args[@]}"
done

[ "$DRY" = 1 ] && { echo "== dry run done"; exit 0; }

echo "== verify registry"
for p in "${PKGS[@]}"; do
  n=$(name "$p")
  for _ in $(seq 1 12); do on_registry "$n" "$VERSION" && break; sleep 5; done
  on_registry "$n" "$VERSION" || die "$n@$VERSION not visible on the registry after 60 s"
  latest=$(npm view "$n" dist-tags.latest 2>/dev/null)
  echo "   $n@$VERSION ok (latest: $latest)"
done

if [ "$SMOKE" = 1 ]; then
  echo "== clean install"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  (cd "$tmp" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund "doltap-wiki@$VERSION" && printf '   doltap --version: ' && ./node_modules/.bin/doltap --version)
fi
echo "== published $VERSION"
