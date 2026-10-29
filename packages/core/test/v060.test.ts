import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendCall, commitAndPush, pushPendingAsync, readCalls, readSyncState, resolveConfig, summarizeCalls } from "../src/index.js";
import { cfgFor, makeTwoMachines, makeWikiCopy, type Fixture } from "./helpers.js";

describe("deferred push (0.6)", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  beforeEach(() => { m = makeTwoMachines(); });
  afterEach(() => m.cleanup());

  it("commitAndPush with deferPush commits, marks the push pending and returns without touching the remote", async () => {
    const cfg = resolveConfig({ root: m.a, agent: "test", deferPush: true });
    writeFileSync(join(m.a, "wiki", "howto", "deferred.md"), "---\ntitle: D\ncategory: howto\nsummary: Deferred.\ntags:\n  - wiki\nconfidence: draft\ncreated: 2026-10-29\nupdated: 2026-10-29\nsources: []\n---\n## Steps\n\n1. d\n");
    const r = commitAndPush(cfg, ["wiki/howto/deferred.md"], "wiki: add howto/deferred");
    expect(r.pushed).toBe(false);
    expect(r.messages).toContain("push deferred to the background flusher");
    expect(readSyncState(cfg).pendingPush).toBe(true);
    const r2 = await pushPendingAsync(cfg);
    expect(r2.pushed).toBe(true);
    expect(readSyncState(cfg).pendingPush).toBe(false);
    expect(await pushPendingAsync(cfg)).toMatchObject({ pushed: false });
  });

  it("DOLTAP_DEFER_PUSH=1 enables it from the environment; the default is off", () => {
    const prev = process.env.DOLTAP_DEFER_PUSH;
    try {
      delete process.env.DOLTAP_DEFER_PUSH;
      expect(resolveConfig({ root: m.a }).deferPush).toBe(false);
      process.env.DOLTAP_DEFER_PUSH = "1";
      expect(resolveConfig({ root: m.a }).deferPush).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DOLTAP_DEFER_PUSH; else process.env.DOLTAP_DEFER_PUSH = prev;
    }
  });
});

describe("HTTP call log (0.6)", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeWikiCopy(); });
  afterEach(() => fx.cleanup());

  it("appends one line per call, reads rotated generations oldest first, and summarises per client", () => {
    const cfg = cfgFor(fx.dir);
    mkdirSync(join(cfg.stateDir, "logs"), { recursive: true });
    writeFileSync(join(cfg.stateDir, "logs", "http-calls.log.1"), "2026-10-01T00:00:00.000Z laptop tools/call wiki_search 200 5\n");
    appendCall(cfg, { ts: "2026-10-02T00:00:00.000Z", client: "laptop", method: "tools/call", tool: "wiki_get", status: "200", ms: 7.6 });
    appendCall(cfg, { ts: "2026-10-03T00:00:00.000Z", client: "bad name\twith tabs", method: "", tool: "", status: "no-token", ms: 1 });
    const all = readCalls(cfg, "2000-01-01");
    expect(all.map((c) => c.tool)).toEqual(["wiki_search", "wiki_get", "-"]);
    expect(all[1].ms).toBe(8);
    expect(all[2]).toMatchObject({ client: "bad_name_with_tabs", method: "-", status: "no-token" });
    expect(readCalls(cfg, "2026-10-02T12:00:00Z")).toHaveLength(1);
    const s = summarizeCalls(all);
    expect(s[0]).toMatchObject({ client: "laptop", calls: 2, errors: 0, last: "2026-10-02T00:00:00.000Z" });
    expect(s[1]).toMatchObject({ client: "bad_name_with_tabs", calls: 1, errors: 1 });
  });
});
