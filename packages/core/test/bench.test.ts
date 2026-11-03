import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lintAll, resolveConfig, WikiDb, type WikiConfig } from "../src/index.js";
import { makeWikiCopy, type Fixture } from "./helpers.js";

/**
 * 0.8 scale check: 5,000 synthetic pages. Off by default (slow); run with DOLTAP_BENCH=1 and optionally
 * DOLTAP_BENCH_PAGES=<n>. Prints a table; the assertions are loose ceilings so a regression shows up when it runs.
 */
const ON = process.env.DOLTAP_BENCH === "1";
const N = Number(process.env.DOLTAP_BENCH_PAGES ?? 5000);
const CATS = ["howto", "reference", "patterns", "decisions"] as const;
const WORDS = ["deploy", "retry", "backoff", "token", "docker", "postgres", "cache", "index", "release", "lint", "schedule", "launchd", "tailscale", "secret", "rotate", "python", "node", "windows", "macos", "linux"];
const pick = (i: number, k: number) => WORDS[(i * 7 + k * 13) % WORDS.length];
const body = (cat: string, i: number) => cat === "howto"
  ? `## Prerequisites\n\n${pick(i, 1)} ${pick(i, 2)}\n\n## Steps\n\n1. Run the ${pick(i, 3)} step\n2. Check ${pick(i, 4)}\n\n## Verification\n\n${pick(i, 5)} works\n\n## Pitfalls\n\n- ${pick(i, 6)} needs ${pick(i, 7)}\n\n## Related\n\n- [[howto/_index]]\n`
  : cat === "reference"
    ? `## Key facts\n\n- ${pick(i, 1)} ${pick(i, 2)}\n\n## Details\n\n${pick(i, 3)} ${pick(i, 4)} ${pick(i, 5)}\n\n## Verified on\n\n2026-11-03\n\n## Related\n\n- [[reference/_index]]\n`
    : cat === "patterns"
      ? `## Problem

${pick(i, 1)} ${pick(i, 2)}

## Solution

${pick(i, 3)} ${pick(i, 4)}

## Variations

- ${pick(i, 5)}

## Anti-patterns

- ${pick(i, 6)}

## Used in

- ${pick(i, 7)}

## Related

- [[patterns/_index]]
`
      : `## Context\n\n${pick(i, 1)} ${pick(i, 2)}\n\n## Options\n\n- ${pick(i, 6)}\n- ${pick(i, 7)}\n\n## Decision\n\n${pick(i, 3)} over ${pick(i, 4)}\n\n## Consequences\n\n- ${pick(i, 5)}\n\n## Related\n\n- [[decisions/_index]]\n`;
const page = (cat: string, i: number) => `---
title: ${cat} page ${i} about ${pick(i, 1)} and ${pick(i, 2)}
category: ${cat}
summary: Synthetic ${cat} page ${i} covering ${pick(i, 1)}, ${pick(i, 2)} and ${pick(i, 3)} for the scale check.
tags: [wiki]
confidence: ${i % 3 ? "draft" : "verified"}
created: 2026-11-03
updated: 2026-11-03
sources: []
---

${body(cat, i)}`;

const ms = (t: [number, number]) => { const d = process.hrtime(t); return d[0] * 1000 + d[1] / 1e6; };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

describe.skipIf(!ON)(`scale check at ${N} pages (DOLTAP_BENCH=1)`, () => {
  let fx: Fixture;
  let cfg: WikiConfig;
  const rows: [string, string][] = [];
  beforeAll(() => {
    fx = makeWikiCopy();
    cfg = resolveConfig({ root: fx.dir, noSync: true, agent: "bench" });
    const t = process.hrtime();
    for (let i = 0; i < N; i++) {
      const cat = CATS[i % CATS.length];
      const dir = join(cfg.wikiDir, cat, `g${Math.floor(i / 200)}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `p${i}.md`), page(cat, i));
    }
    rows.push(["generate pages", `${ms(t).toFixed(0)} ms`]);
  }, 120_000);
  afterAll(() => {
    const table = `scale check, ${N} pages\n${rows.map(([k, v]) => `${k.padEnd(36)} ${v}`).join("\n")}\n`;
    process.stderr.write(`\n${table}\n`);
    if (process.env.DOLTAP_BENCH_OUT) writeFileSync(process.env.DOLTAP_BENCH_OUT, JSON.stringify({ pages: N, rows }, null, 2) + "\n");
    fx.cleanup();
  });

  it("full reindex, no-op reindex and incremental reindex of ten changed files", () => {
    const db = new WikiDb(cfg);
    try {
      let t = process.hrtime();
      const full = db.reindex(true);
      const fullMs = ms(t);
      rows.push(["full reindex", `${fullMs.toFixed(0)} ms (${full.total} pages)`]);
      expect(full.total).toBeGreaterThanOrEqual(N);
      t = process.hrtime();
      const noop = db.reindex();
      const noopMs = ms(t);
      rows.push(["no-op reindex (per request)", `${noopMs.toFixed(0)} ms (${noop.indexed} re-parsed)`]);
      expect(noop.indexed).toBe(0);
      const future = new Date(Date.now() + 5000);
      for (let i = 0; i < 10; i++) {
        const cat = CATS[i % CATS.length];
        const f = join(cfg.wikiDir, cat, "g0", `p${i}.md`);
        writeFileSync(f, page(cat, i).replace("Synthetic", "Changed"));
        utimesSync(f, future, future);
      }
      t = process.hrtime();
      const inc = db.reindex();
      const incMs = ms(t);
      rows.push(["incremental reindex (10 changed)", `${incMs.toFixed(0)} ms (${inc.indexed} re-parsed)`]);
      expect(inc.indexed).toBe(10);
      expect(fullMs).toBeLessThan(120_000);
      expect(noopMs).toBeLessThan(5_000);
    } finally { db.close(); }
  }, 300_000);

  it("search latency over 40 queries", () => {
    const db = new WikiDb(cfg);
    try {
      db.reindex();
      const qs = WORDS.flatMap((w, i) => [w, `${w} ${WORDS[(i + 3) % WORDS.length]}`]);
      const times: number[] = [];
      let hits = 0;
      for (const q of qs) { const t = process.hrtime(); hits += db.search(q, { limit: 10 }).length; times.push(ms(t)); }
      rows.push(["search p50 / p95", `${pct(times, 0.5).toFixed(1)} / ${pct(times, 0.95).toFixed(1)} ms (${hits} hits over ${qs.length} queries)`]);
      expect(pct(times, 0.95)).toBeLessThan(2_000);
    } finally { db.close(); }
  }, 300_000);

  it("lintAll over the whole wiki", () => {
    const t = process.hrtime();
    const issues = lintAll(cfg);
    rows.push(["lintAll", `${ms(t).toFixed(0)} ms (${issues.length} issues)`]);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  }, 600_000);
});
