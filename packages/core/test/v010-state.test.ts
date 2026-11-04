import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { doctor, resolveConfig, serviceLabels, stateDirFor, syncAll, trackedStateFiles, wikiId, writeLockPath, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, makeWikiCopy, sh, type Fixture } from "./helpers.js";

/**
 * 0.10: per-machine state (index, lock, sync state, token, client list, logs) lives outside the git tree,
 * under $DOLTAP_STATE_HOME/<wiki-id>/ (default $XDG_STATE_HOME/doltap). Nothing a collaborator pushes can
 * land there. A clone that still has the 0.x `.doltap/` directory is migrated once, token bytes intact.
 */
const win = platform() === "win32";

describe("state directory location", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeWikiCopy(); });
  afterEach(() => fx.cleanup());

  it("is outside the root, keyed by the wiki id, and created private", () => {
    const cfg = resolveConfig({ root: fx.dir, noSync: true });
    expect(cfg.stateDir.startsWith(resolve(fx.dir) + sep)).toBe(false);
    expect(cfg.stateDir).toBe(join(process.env.DOLTAP_STATE_HOME!, wikiId(fx.dir)));
    expect(cfg.dbPath).toBe(join(cfg.stateDir, "index.sqlite"));
    expect(cfg.legacyStateDir).toBe(join(resolve(fx.dir), ".doltap"));
    expect(existsSync(join(fx.dir, ".doltap"))).toBe(false);
    if (!win) expect(statSync(cfg.stateDir).mode & 0o077).toBe(0);
  });

  it("the wiki id is the root's name plus a hash of its real path", () => {
    const id = wikiId(fx.dir);
    expect(id).toMatch(new RegExp(`^${basename(fx.dir)}-[0-9a-f]{8}$`));
    expect(wikiId(fx.dir)).toBe(id);
    expect(wikiId(join(fx.dir, "..", basename(fx.dir)))).toBe(id);
    const other = makeWikiCopy();
    try { expect(wikiId(other.dir)).not.toBe(id); } finally { other.cleanup(); }
  });

  it("DOLTAP_STATE_DIR names the directory for this wiki directly", () => {
    const explicit = mkdtempSync(join(tmpdir(), "doltap-explicit-state-"));
    const prev = process.env.DOLTAP_STATE_DIR;
    process.env.DOLTAP_STATE_DIR = explicit;
    try {
      expect(stateDirFor(fx.dir)).toBe(resolve(explicit));
      const cfg = resolveConfig({ root: fx.dir, noSync: true });
      expect(cfg.stateDir).toBe(resolve(explicit));
      expect(writeLockPath(cfg)).toBe(join(resolve(explicit), "write.lock"));
    } finally {
      if (prev === undefined) delete process.env.DOLTAP_STATE_DIR; else process.env.DOLTAP_STATE_DIR = prev;
      rmSync(explicit, { recursive: true, force: true });
    }
  });
});

describe("migration from <root>/.doltap", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  beforeEach(() => { m = makeTwoMachines(); });
  afterEach(() => m.cleanup());

  const plantLegacy = (root: string) => {
    const legacy = join(root, ".doltap");
    mkdirSync(join(legacy, "logs"), { recursive: true });
    writeFileSync(join(legacy, "http-token"), "ab".repeat(32) + "\n", { mode: 0o600 });
    writeFileSync(join(legacy, "http-clients.json"), JSON.stringify({ laptop: { token: "cd".repeat(32), readOnly: true, created: "2026-01-01" } }), { mode: 0o600 });
    writeFileSync(join(legacy, "sync.json"), JSON.stringify({ pendingPush: true }));
    writeFileSync(join(legacy, "index.sqlite"), "not really a database");
    writeFileSync(join(legacy, "logs", "sync.log"), "old log\n");
    writeFileSync(join(legacy, "http-client-gb10.token"), "ef".repeat(32) + "\n", { mode: 0o600 });
    writeFileSync(join(legacy, "write.lock"), "1 2026-01-01T00:00:00.000Z\n");
    return legacy;
  };

  it("moves the private files once, keeps token bytes, drops the stale lock and leaves nothing behind", () => {
    const legacy = plantLegacy(m.a);
    const cfg = resolveConfig({ root: m.a, agent: "test" });
    expect(cfg.stateDir).not.toBe(legacy);
    expect(readFileSync(join(cfg.stateDir, "http-token"), "utf8")).toBe("ab".repeat(32) + "\n");
    expect(JSON.parse(readFileSync(join(cfg.stateDir, "http-clients.json"), "utf8"))).toHaveProperty("laptop");
    expect(JSON.parse(readFileSync(join(cfg.stateDir, "sync.json"), "utf8"))).toEqual({ pendingPush: true });
    expect(readFileSync(join(cfg.stateDir, "logs", "sync.log"), "utf8")).toBe("old log\n");
    expect(readFileSync(join(cfg.stateDir, "http-client-gb10.token"), "utf8")).toBe("ef".repeat(32) + "\n");
    expect(existsSync(join(cfg.stateDir, "write.lock"))).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    if (!win) {
      expect(statSync(join(cfg.stateDir, "http-token")).mode & 0o077).toBe(0);
      expect(statSync(cfg.stateDir).mode & 0o077).toBe(0);
    }
    // A second resolve is a no-op; a legacy directory that reappears later is not merged over live state.
    const again = resolveConfig({ root: m.a, agent: "test" });
    expect(again.stateDir).toBe(cfg.stateDir);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "http-token"), "99".repeat(32) + "\n");
    resolveConfig({ root: m.a, agent: "test" });
    expect(readFileSync(join(cfg.stateDir, "http-token"), "utf8")).toBe("ab".repeat(32) + "\n");
    expect(existsSync(join(legacy, "http-token"))).toBe(true);
  });

  it("never moves what git tracks or what is a symlink, and the leftovers are reported", async () => {
    const legacy = plantLegacy(m.a);
    writeFileSync(join(legacy, "planted.json"), "{}");
    sh(m.a, "git", ["add", "-f", ".doltap/planted.json"]);
    sh(m.a, "git", ["commit", "-qm", "plant"]);
    const outside = join(dirname(m.a), `target-${process.pid}.txt`);
    writeFileSync(outside, "secret\n");
    if (!win) symlinkSync(outside, join(legacy, "linked.txt"));
    const cfg = { ...resolveConfig({ root: m.a, agent: "test" }), hostname: "machine-a", autoPullMinutes: 0 } as WikiConfig;
    expect(existsSync(join(cfg.stateDir, "planted.json"))).toBe(false);
    expect(existsSync(join(cfg.stateDir, "linked.txt"))).toBe(false);
    expect(existsSync(join(legacy, "planted.json"))).toBe(true);
    expect(readFileSync(join(cfg.stateDir, "http-token"), "utf8")).toBe("ab".repeat(32) + "\n");
    expect(trackedStateFiles(cfg)).toEqual([".doltap/planted.json"]);
    expect(syncAll(cfg).messages.join("\n")).toMatch(/\.doltap\/planted\.json tracked by git/);
    const d = await doctor(cfg, { services: false });
    const state = d.checks.find((c) => c.name === "state")!;
    expect(state.status).toBe("warn");
    expect(state.detail).toMatch(/planted\.json/);
    expect(state.detail).toMatch(/leftover|no longer/);
    expect(state.fix).toMatch(/git rm --cached/);
  });

  it("a clean clone gets an ok state check that names the private directory", async () => {
    const cfg = { ...resolveConfig({ root: m.b, agent: "test" }), hostname: "machine-b", autoPullMinutes: 0 } as WikiConfig;
    const d = await doctor(cfg, { services: false });
    const state = d.checks.find((c) => c.name === "state")!;
    expect(state.status).toBe("ok");
    expect(state.detail).toContain(cfg.stateDir);
  });
});

describe("service labels are per wiki", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeWikiCopy(); });
  afterEach(() => fx.cleanup());

  it("carry the wiki id, so two wikis on one machine do not replace each other's jobs", () => {
    const cfg = resolveConfig({ root: fx.dir, noSync: true });
    const l = serviceLabels(cfg);
    expect(l.sync).toBe(`com.doltap.sync.${cfg.wikiId}`);
    expect(l.mcp).toBe(`com.doltap.mcp.${cfg.wikiId}`);
    expect(l.task).toBe(`DoltapSync-${cfg.wikiId}`);
    expect(l.cronMarker).toBe(`# doltap-sync ${cfg.wikiId}`);
    expect(l.legacy).toEqual({ sync: "com.doltap.sync", mcp: "com.doltap.mcp", task: "DoltapSync", cronMarker: "# doltap-sync" });
  });
});
