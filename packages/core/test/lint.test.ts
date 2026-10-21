import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLintContext, lintPage, parsePage } from "../src/index.js";
import { cfgFor, makeWikiCopy, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => { fx = makeWikiCopy(); });
afterEach(() => fx.cleanup());

const good = `---
title: Rotate a JWT secret
category: howto
summary: Rotate the signing secret without logging users out.
tags: [auth, security]
confidence: draft
created: 2026-10-18
updated: 2026-10-18
sources: []
---

## Prerequisites

x

## Steps

1. y

## Verification

z

## Pitfalls

- w

## Related

- [[howto/_index]]
`;

function lint(raw: string, relPath = "howto/rotate-jwt-secret.md") {
  const cfg = cfgFor(fx.dir);
  const page = parsePage(cfg, relPath, raw);
  const ctx = buildLintContext(cfg, new Set(["howto/_index", page.id]), new Map([[page.id, 1]]));
  return lintPage(page, ctx).map((i) => i.rule);
}

describe("lint rules", () => {
  it("accepts a well-formed page", () => expect(lint(good)).toEqual([]));
  it("rejects unknown tags and category mismatch", () => {
    expect(lint(good.replace("[auth, security]", "[auth, bogus]"))).toContain("tag-unknown");
    expect(lint(good, "patterns/rotate-jwt-secret.md")).toContain("category-mismatch");
  });
  it("rejects missing required sections and long summaries", () => {
    expect(lint(good.replace("## Verification\n\nz\n\n", ""))).toContain("section-missing");
    expect(lint(good.replace("Rotate the signing secret without logging users out.", "x".repeat(201)))).toContain("summary-length");
  });
  it("flags broken links, secrets and non-English prose", () => {
    expect(lint(good.replace("[[howto/_index]]", "[[howto/does-not-exist]]"))).toContain("link-broken");
    expect(lint(good.replace("1. y", "1. export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"))).toContain("secret");
    expect(lint(good.replace("1. y", "1. curl https://deploy:hunter2pass@git.internal.example/repo.git"))).toContain("secret");
    expect(lint(good.replace("1. y", "1. curl https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ/getMe"))).toContain("secret");
    // Internal hosts and secret locations are allowed
    expect(lint(good.replace("1. y", "1. ssh admin@build.lan; curl http://10.0.0.5:8080/health"))).not.toContain("secret");
    expect(lint(good.replace("1. y", "1. export KEY=$(security find-generic-password -s orcarouter-api -w)"))).not.toContain("secret");
    expect(lint(good.replace("1. y", "1. 이것은 한국어로 작성된 긴 문장입니다. 위키는 영어로 써야 합니다."))).toContain("language");
  });
  it("warns on empty sections and bad slugs", () => {
    expect(lint(good.replace("## Pitfalls\n\n- w", "## Pitfalls\n"))).toContain("section-empty");
    expect(lint(good.replace("## Steps\n\n1. y", "## Steps\n\n### Weekly\n\n1. y"))).not.toContain("section-empty");
    expect(lint(good, "howto/Rotate_JWT.md")).toContain("slug-format");
  });
});
