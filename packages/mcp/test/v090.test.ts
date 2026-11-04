import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig, type WikiConfig } from "@bluekds/doltap-core";
import { makeTwoMachines, makeWikiCopy, sh, type Fixture } from "../../core/test/helpers.js";
import { clientsPath, loadClients, loadOrCreateToken, tokenPath } from "../src/http.js";

/** 0.9 security audit S2: a client list or token file that git tracks, or that is a symlink, is never used. */
const GOOD = "ab".repeat(32);

describe("http-clients.json is used only when it is this machine's private file", () => {
  let fx: Fixture;
  let cfg: WikiConfig;
  beforeEach(() => { fx = makeWikiCopy(); cfg = resolveConfig({ root: fx.dir, agent: "t", noSync: true }); });
  afterEach(() => fx.cleanup());

  const write = (clients: unknown) => writeFileSync(clientsPath(cfg), JSON.stringify(clients), { mode: 0o600 });

  it("accepts a private file; drops entries whose token is not 64 hex", () => {
    write({ laptop: { token: GOOD, readOnly: false, created: "2026-10-01" }, short: { token: "abc", readOnly: false, created: "2026-10-01" }, upper: { token: "AB".repeat(32), readOnly: true, created: "2026-10-01" } });
    expect(Object.keys(loadClients(cfg))).toEqual(["laptop"]);
  });

  it("ignores a symlinked file", () => {
    const outside = join(fx.dir, "..", `clients-${process.pid}.json`);
    writeFileSync(outside, JSON.stringify({ evil: { token: GOOD, readOnly: false, created: "2026-10-01" } }));
    symlinkSync(outside, clientsPath(cfg));
    expect(loadClients(cfg)).toEqual({});
  });
});

describe("tracked state files (pushed by a collaborator)", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let B: WikiConfig;
  beforeEach(() => {
    m = makeTwoMachines();
    B = { ...resolveConfig({ root: m.b, agent: "victim" }), autoPullMinutes: 0 };
    mkdirSync(join(m.a, ".doltap"), { recursive: true });
    writeFileSync(join(m.a, ".doltap", "http-clients.json"), JSON.stringify({ evil: { token: GOOD, readOnly: false, created: "2026-01-01" } }));
    writeFileSync(join(m.a, ".doltap", "http-token"), "e".repeat(64) + "\n");
    sh(m.a, "git", ["add", "-f", ".doltap/http-clients.json", ".doltap/http-token"]);
    sh(m.a, "git", ["commit", "-qm", "wiki: plant"]);
    sh(m.a, "git", ["push", "-q"]);
    sh(m.b, "git", ["pull", "-q", "--rebase"]);
  });
  afterEach(() => m.cleanup());

  it("a pushed client list or token file is never where the server looks (0.10: state lives outside the clone)", () => {
    expect(clientsPath(B).startsWith(m.b)).toBe(false);
    expect(tokenPath(B).startsWith(m.b)).toBe(false);
    expect(loadClients(B)).toEqual({});
    const t = loadOrCreateToken(B);
    expect(t).not.toBe("e".repeat(64));
    expect(existsSync(join(m.b, ".doltap", "http-token"))).toBe(true); // the pushed file stays in the clone, unused
  });
});
