import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLintContext, lintPage, parsePage } from "../src/index.js";
import { cfgFor, makeWikiCopy, type Fixture } from "./helpers.js";

/** 0.8: a credential wrapped across two lines (editor soft-wrap, copied from a narrow terminal) is still a credential. Fake values are concatenated so push protection never sees a literal. */
let fx: Fixture;
beforeEach(() => { fx = makeWikiCopy(); });
afterEach(() => fx.cleanup());

const page = (step: string) => `---
title: Example page
category: howto
summary: A page used to exercise the secret filter.
tags: [security]
confidence: draft
created: 2026-11-03
updated: 2026-11-03
sources: []
---

## Prerequisites

x

## Steps

1. ${step}

## Verification

z

## Pitfalls

- w

## Related

- [[howto/_index]]
`;

function issues(step: string) {
  const cfg = cfgFor(fx.dir);
  const ctx = buildLintContext(cfg, new Set(["howto/_index"]), new Map());
  return lintPage(parsePage(cfg, "howto/example-page.md", page(step)), ctx);
}
const rules = (step: string) => issues(step).map((i) => i.rule);

const anthropic = "sk-ant-" + "api03-" + "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eFgH1jK4mN7pQ0sT3vW6yZ9";
const aws = "AKIA" + "J7X2M9Q4R1T6W8Y3";
const gh = "ghp_" + "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eFgH1jK4";

describe("secret filter: a key split across two lines (0.8)", () => {
  it("flags a key wrapped at a line break, with or without indentation on the continuation", () => {
    expect(rules(anthropic.slice(0, 20) + "\n" + anthropic.slice(20))).toContain("secret");
    expect(rules(aws.slice(0, 12) + "\n   " + aws.slice(12))).toContain("secret");
    expect(rules("export GH=" + gh.slice(0, 20) + "\n" + gh.slice(20))).toContain("secret");
  });
  it("names the rule so the author knows what to look for", () => {
    const i = issues(anthropic.slice(0, 20) + "\n" + anthropic.slice(20)).find((x) => x.rule === "secret");
    expect(i?.message).toMatch(/anthropic-key/);
    expect(i?.message).toMatch(/across lines/);
  });
  it("does not flag ordinary wrapped prose, lists or hyphenated line ends", () => {
    for (const ok of [
      "Install the package, then\nrun the build and check the log",
      "- first item\n- second item\n- third item",
      "the pre-\nrelease build from 2026-11-03 is fine",
      "AKIA is the AWS key prefix; see\nIAM docs for the 16 characters that follow",
      "set TOKEN=$(security find-generic-password -s doltap -w)\nexport TOKEN",
    ]) expect(rules(ok)).not.toContain("secret");
  });
  it("a placeholder split across lines is still a placeholder", () => {
    expect(rules("sk-ant-api03-YOUR_" + "\n" + "KEY_HERE_abcdefghijklmnop")).not.toContain("secret");
  });
});
