import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cronStep, doctor, obsidianWarnings, resolveConfig, syncAll, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, sh } from "./helpers.js";

/** 0.9.1 security audit S9 and core L11: the shared Obsidian config is checked for code-execution hooks; cron steps above 59 minutes are real. */
const SKEL_OBSIDIAN = fileURLToPath(new URL("../skeleton/wiki/dot.obsidian/", import.meta.url));

let m: ReturnType<typeof makeTwoMachines>;
let A: WikiConfig;
beforeEach(() => {
  m = makeTwoMachines();
  A = { ...resolveConfig({ root: m.a, agent: "test-a", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
});
afterEach(() => m.cleanup());

const obsidian = () => join(m.a, "wiki", ".obsidian");
const commitAll = (msg: string) => { sh(m.a, "git", ["add", "-A"]); sh(m.a, "git", ["commit", "-qm", msg]); };

describe("S9: Obsidian config pushed by a collaborator", () => {
  it("the skeleton config raises nothing", () => {
    cpSync(SKEL_OBSIDIAN, obsidian(), { recursive: true });
    commitAll("obsidian config");
    expect(obsidianWarnings(A)).toEqual([]);
  });

  it("a tracked plugin binary, an extra community plugin and DataviewJS are each reported by sync and doctor", async () => {
    cpSync(SKEL_OBSIDIAN, obsidian(), { recursive: true });
    mkdirSync(join(obsidian(), "plugins", "evil"), { recursive: true });
    writeFileSync(join(obsidian(), "plugins", "evil", "main.js"), "require('child_process')\n");
    writeFileSync(join(obsidian(), "community-plugins.json"), JSON.stringify(["dataview", "obsidian-git", "evil"]));
    writeFileSync(join(obsidian(), "plugins", "dataview", "data.json"), JSON.stringify({ enableDataviewJs: true, enableInlineDataviewJs: true }));
    sh(m.a, "git", ["add", "-f", "-A"]);
    sh(m.a, "git", ["commit", "-qm", "evil config"]);
    const w = obsidianWarnings(A);
    expect(w.join("\n")).toMatch(/plugins\/evil\/main\.js/);
    expect(w.join("\n")).toMatch(/community-plugins\.json.*evil/);
    expect(w.join("\n")).toMatch(/enableDataviewJs/);
    expect(syncAll(A).messages.some((x) => x.startsWith("WARNING") && x.includes("main.js"))).toBe(true);
    const d = await doctor(A, { services: false });
    const c = d.checks.find((x) => x.name === "obsidian");
    expect(c?.status).toBe("warn");
    expect(c?.detail).toMatch(/main\.js/);
  });
});

describe("L11: cron step", () => {
  it("renders minutes under an hour as a step and whole hours as an hourly step; refuses the rest", () => {
    expect(cronStep(10)).toBe("*/10 * * * *");
    expect(cronStep(59)).toBe("*/59 * * * *");
    expect(cronStep(60)).toBe("0 */1 * * *");
    expect(cronStep(180)).toBe("0 */3 * * *");
    expect(() => cronStep(90)).toThrow(/multiple of 60/);
    expect(() => cronStep(0)).toThrow();
  });
});
