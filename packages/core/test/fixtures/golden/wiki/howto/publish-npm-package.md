---
title: Publish an npm package
category: howto
summary: >-
  Publish a scoped package to the npm registry by hand with a passkey, then verify propagation.
tags:
  - release
  - node
confidence: draft
created: 2026-10-25
updated: 2026-10-25
sources: []
---
## Prerequisites

- `npm login` done with a passkey; 2FA on.

## Steps

1. `npm version minor` bumps and tags.
2. `npm publish --access public` from the package directory.
3. `npm view <pkg> version` shows the new version after a minute or two.

## Verification

A clean `npm i <pkg>@<version>` in an empty directory works.

## Pitfalls

- The registry lags about two minutes; polling right after publish shows the old version.

## Related

- [[howto/deploy-pypi]]
