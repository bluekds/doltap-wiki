---
title: Deploy a package to PyPI
category: howto
summary: >-
  Release a Python package to PyPI through GitHub Actions trusted publishing: bump, tag, let the workflow build and upload.
tags:
  - python
  - release
  - ci
confidence: verified
created: 2026-07-02
updated: 2026-09-10
sources: []
---
## Prerequisites

- The project is registered as a trusted publisher on pypi.org (owner, repository, workflow file name).
- `pyproject.toml` has the version; the release workflow runs `python -m build` and `pypa/gh-action-pypi-publish`.

## Steps

1. Bump the version in `pyproject.toml` and the changelog; commit.
2. Tag: `git tag v1.2.3 && git push --tags`.
3. The workflow builds the wheel and sdist and uploads them with an OIDC token; no API token is stored anywhere.
4. Check the release page on pypi.org.

## Verification

`pip install <package>==1.2.3` in a clean virtualenv imports the package.

## Pitfalls

- A tag that does not match the version in `pyproject.toml` is rejected by the upload step.
- Trusted publishing needs the environment name to match exactly.

## Related

- [[howto/publish-npm-package]]
