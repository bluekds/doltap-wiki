import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfgFor, makeTwoMachines, sh } from "./helpers.js";
import { applyUpgrade, planUpgrade, type WikiConfig } from "../src/index.js";

let m: ReturnType<typeof makeTwoMachines>;
let cfg: WikiConfig;
beforeEach(() => { m = makeTwoMachines(); cfg = cfgFor(m.a); });
afterEach(() => m.cleanup());

const item = (plan: ReturnType<typeof planUpgrade>, path: string) => plan.items.find((i) => i.path === path)!;

describe("upgrade", () => {
  it("classifies skeleton files and ignores date-only differences in templates", () => {
    const plan = planUpgrade(cfg);
    expect(item(plan, ".gitattributes").class).toBe("merge");
    expect(item(plan, "wiki/_meta/PROTOCOL.md").class).toBe("review");
    expect(item(plan, "wiki/_meta/templates/howto.md").class).toBe("replace");
    expect(item(plan, "wiki/Home.md").class).toBe("page");
    expect(plan.applicable.map((i) => i.path)).not.toContain("wiki/_meta/templates/howto.md");
    const tpl = join(cfg.wikiDir, "_meta", "templates", "howto.md");
    writeFileSync(tpl, readFileSync(tpl, "utf8").replace(/^created: .*$/m, "created: 2020-01-01"));
    expect(item(planUpgrade(cfg), "wiki/_meta/templates/howto.md").status).toBe("same");
  });

  it("merges missing lines, replaces tool-owned files, leaves PROTOCOL for review, and commits once", () => {
    const attrs = join(m.a, ".gitattributes");
    writeFileSync(attrs, "# mine\n*.png binary\n");
    const tpl = join(cfg.wikiDir, "_meta", "templates", "howto.md");
    writeFileSync(tpl, readFileSync(tpl, "utf8").replace("## Pitfalls", "## Gotchas"));
    const proto = join(cfg.wikiDir, "_meta", "PROTOCOL.md");
    writeFileSync(proto, readFileSync(proto, "utf8") + "\n## Local rules\n\n- ours\n");
    rmSync(join(cfg.wikiDir, ".obsidian", "app.json"), { force: true }); // the fixture ships no .obsidian/ at all
    sh(m.a, "git", ["add", "-A"]);
    sh(m.a, "git", ["commit", "-q", "-m", "customise"]);

    const plan = planUpgrade(cfg, { diff: true });
    expect(item(plan, ".gitattributes")).toMatchObject({ status: "differs", addLines: expect.arrayContaining([expect.stringContaining("merge=union")]) });
    expect(item(plan, "wiki/_meta/templates/howto.md").diff).toContain("-## Pitfalls");
    expect(item(plan, "wiki/.obsidian/app.json").status).toBe("missing");
    expect(plan.review.map((i) => i.path)).toEqual(["wiki/_meta/PROTOCOL.md"]);
    expect(item(plan, "wiki/_meta/PROTOCOL.md").diff).toContain("+## Local rules");

    const r = applyUpgrade(cfg, plan);
    expect(r.applied).toEqual(expect.arrayContaining([".gitattributes", "wiki/.obsidian/app.json", "wiki/_meta/templates/howto.md"]));
    expect(r.applied).not.toContain("wiki/_meta/PROTOCOL.md");
    expect(r.applied).not.toContain("wiki/Home.md");
    expect(r.skipped).toEqual(["wiki/_meta/PROTOCOL.md"]);
    const merged = readFileSync(attrs, "utf8");
    expect(merged.startsWith("# mine\n*.png binary\n")).toBe(true);
    expect(merged).toContain("merge=union");
    expect(readFileSync(tpl, "utf8")).toContain("## Pitfalls");
    expect(readFileSync(proto, "utf8")).toContain("## Local rules");
    expect(sh(m.a, "git", ["log", "-1", "--format=%s"])).toMatch(/^wiki: upgrade skeleton to \d+\.\d+\.\d+/);
    expect(sh(m.a, "git", ["status", "--porcelain"])).toBe("");
    const again = planUpgrade(cfg);
    expect(again.applicable).toEqual([]);
    expect(again.review.map((i) => i.path)).toEqual(["wiki/_meta/PROTOCOL.md"]);
  });
});
