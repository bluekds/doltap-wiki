import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLintContext, lintPage, parsePage, resolveConfig } from "../src/index.js";
import { cfgFor, makeWikiCopy, type Fixture } from "./helpers.js";

/** 0.7.1: secret-filter gaps and false positives found by the MCP/security review. Fake values are built by concatenation so push protection never sees a literal. */
let fx: Fixture;
beforeEach(() => { fx = makeWikiCopy(); });
afterEach(() => fx.cleanup());

const page = (line: string) => `---
title: Example page
category: howto
summary: A page used to exercise the secret filter.
tags: [security]
confidence: draft
created: 2026-11-02
updated: 2026-11-02
sources: []
---

## Prerequisites

x

## Steps

1. ${line}

## Verification

z

## Pitfalls

- w

## Related

- [[howto/_index]]
`;

function rules(line: string): string[] {
  const cfg = cfgFor(fx.dir);
  const ctx = buildLintContext(cfg, new Set(["howto/_index"]), new Map());
  return lintPage(parsePage(cfg, "howto/example-page.md", page(line)), ctx).map((i) => i.rule);
}
const hex64 = "0123456789abcdef".repeat(4);

describe("secret filter: previously missed formats", () => {
  const cases: [string, string][] = [
    ["tailscale auth key", "tskey-" + "auth-" + "kJ8vb2CNTRL-" + "ab12cd34ef56gh78ij90kl12mn34op56"],
    ["slack webhook", "https://hooks.slack.com/services/" + "T0123ABCD/B0456EFGH/" + "aBcDeFgHiJkLmNoPqRsTuVwX"],
    ["azure account key", "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=" + "aGVsbG8gd29ybGQgdGhpcyBpcyBhIGZha2Uga2V5IGZvciB0ZXN0cw" + "=="],
    ["uppercase connector url", "https://box.example.ts.net/" + hex64.toUpperCase() + "/mcp"],
    ["bare 64-hex token after a slash", "curl http://127.0.0.1:8765/" + hex64 + " # path token"],
    ["short unquoted password with a digit", "DB_PASSWORD=" + "h7Kq2pLm9xZr"],
  ];
  for (const [name, line] of cases) it(`flags ${name}`, () => expect(rules(line)).toContain("secret"));
  it("still allows hostnames, load commands and plain hex ids", () => {
    expect(rules("export TOKEN=$(security find-generic-password -s doltap -w)")).not.toContain("secret");
    expect(rules("commit 9defdaf fixed it; see https://ds-macmini.tail1234.ts.net/healthz")).not.toContain("secret");
    expect(rules("sha256: " + hex64)).not.toContain("secret");
    expect(rules("DB_PASSWORD=changeme")).not.toContain("secret");
  });
});

describe("secret filter: placeholders and prose are not secrets", () => {
  const ok = [
    "AWS docs use the example key AKIA" + "IOSFODNN7EXAMPLE",
    'token: "YOUR_TOKEN_HERE"',
    "api_key: <your-api-key>",
    "password = xxxxxxxxxxxxxxxxxxxx",
    "see the sk-learn-preprocessing-pipeline-guide for details",
    "Authorization: Bearer <access-token-from-step-2>",
  ];
  for (const line of ok) it(`accepts ${line.slice(0, 40)}`, () => expect(rules(line)).not.toContain("secret"));
  it("still flags real-looking keys next to placeholders", () => {
    expect(rules("sk-" + "proj-" + "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF")).toContain("secret");
    expect(rules("AKIA" + "J7X2M9Q4R1T6W8Y3")).toContain("secret");
  });
});

describe("explicit root", () => {
  it("an explicit --root or DOLTAP_ROOT that is not a wiki is an error, not a fallback to ~/.doltap", () => {
    const empty = mkdtempSync(join(tmpdir(), "doltap-empty-"));
    try {
      expect(() => resolveConfig({ root: empty })).toThrow(/not a wiki/);
      const prev = process.env.DOLTAP_ROOT;
      process.env.DOLTAP_ROOT = empty;
      try { expect(() => resolveConfig({})).toThrow(/not a wiki/); } finally { if (prev === undefined) delete process.env.DOLTAP_ROOT; else process.env.DOLTAP_ROOT = prev; }
      expect(resolveConfig({ root: fx.dir }).root).toBe(fx.dir);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});
