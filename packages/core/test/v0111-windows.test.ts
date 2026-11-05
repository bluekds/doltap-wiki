import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseSchtasksCsv, resolveConfig, serviceLabels, stateHome, wikiId, windowsSyncScript, type WikiConfig } from "../src/index.js";
import { makeWikiCopy, type Fixture } from "./helpers.js";

/**
 * 0.11.1, from the first real Windows run: the scheduled task failed before writing a log because the
 * Task Scheduler reads the nested quotes of a `cmd /c "..."` action differently from a shell, the status
 * query is localised ("상태:" on a Korean Windows), and a root named `.doltap` gave the wiki a dotted id.
 */
let fx: Fixture;
let cfg: WikiConfig;
beforeEach(() => { fx = makeWikiCopy(); cfg = resolveConfig({ root: fx.dir, noSync: true }); });
afterEach(() => fx.cleanup());

describe("Windows scheduled sync", () => {
  it("runs through a wrapper script in the state dir, so the task action is one quoted path", () => {
    const w = windowsSyncScript(cfg, "C:\\nvm\\v22\\node_modules\\doltap-wiki\\dist\\cli.js", "C:\\nvm4w\\nodejs\\node.exe");
    expect(w.script).toBe(join(cfg.stateDir, "sync.cmd"));
    expect(w.taskRun).toBe(`"${w.script}"`);
    expect(w.content).toContain("@echo off");
    expect(w.content).toContain(`"C:\\nvm4w\\nodejs\\node.exe" "C:\\nvm\\v22\\node_modules\\doltap-wiki\\dist\\cli.js" --root "${cfg.root}" --agent scheduler sync >> "${join(cfg.stateDir, "logs", "sync.log")}" 2>&1`);
    expect(w.content.split("\n").filter((l) => l.includes("node.exe"))).toHaveLength(1);
  });

  it("reads the task status from the CSV form, which has no localised labels", () => {
    expect(parseSchtasksCsv('"DoltapSync-x","2026-11-05 오후 3:54:00","준비"\r\n')).toEqual({ next: "2026-11-05 오후 3:54:00", status: "준비" });
    expect(parseSchtasksCsv('"\\DoltapSync-x","N/A","Ready"\n')).toEqual({ next: "N/A", status: "Ready" });
    expect(parseSchtasksCsv("")).toBeNull();
  });
});

describe("wiki id", () => {
  it("never starts with a dot, and a state dir created under the dotted id is adopted once", () => {
    const parent = fx.dir;
    const root = join(parent, ".doltap");
    mkdirSync(join(root, "wiki", "_meta"), { recursive: true });
    writeFileSync(join(root, "wiki", "_meta", "PROTOCOL.md"), "# p\n");
    const id = wikiId(root);
    expect(id).toMatch(/^doltap-[0-9a-f]{8}$/);
    expect(basename(root)).toBe(".doltap");
    // 0.10 / 0.11.0 named the dir `.doltap-<hash>`; its content (an index, a token) must carry over.
    const old = join(stateHome(), `.${id}`);
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "http-token"), "ab".repeat(32) + "\n");
    const c = resolveConfig({ root, noSync: true });
    expect(c.wikiId).toBe(id);
    expect(basename(c.stateDir)).toBe(id);
    expect(readFileSync(join(c.stateDir, "http-token"), "utf8")).toBe("ab".repeat(32) + "\n");
    expect(existsSync(old)).toBe(false);
    expect(dirname(c.stateDir)).toBe(stateHome());
  });

  it("the legacy service names include the dotted form so install and uninstall clean it up", () => {
    const l = serviceLabels({ wikiId: "doltap-214db1a6" });
    expect(l.task).toBe("DoltapSync-doltap-214db1a6");
    expect(l.legacy.map((x) => x.task)).toEqual(["DoltapSync-.doltap-214db1a6", "DoltapSync"]);
    expect(l.legacy.map((x) => x.sync)).toEqual(["com.doltap.sync..doltap-214db1a6", "com.doltap.sync"]);
    const m = serviceLabels({ wikiId: "AgentWiki-77047fe7" });
    expect(m.legacy.map((x) => x.task)).toEqual(["DoltapSync"]);
    if (platform() === "win32") expect(m.task).toBe("DoltapSync-AgentWiki-77047fe7");
  });
});
