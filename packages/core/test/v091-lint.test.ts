import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lintAll, type WikiConfig } from "../src/index.js";
import { cfgFor, makeWikiCopy, type Fixture } from "./helpers.js";

/** A project directory without its overview page used to go unnoticed: topic pages were listed straight in projects/_index. */
let fx: Fixture;
let cfg: WikiConfig;
beforeEach(() => { fx = makeWikiCopy(); cfg = cfgFor(fx.dir); });
afterEach(() => fx.cleanup());

const page = (title: string, body: string) => `---\ntitle: ${title}\ncategory: projects\nsummary: ${title}.\ntags:\n  - wiki\nconfidence: draft\ncreated: 2026-11-01\nupdated: 2026-11-01\nsources: []\n---\n${body}`;

describe("project-no-overview", () => {
  it("warns on every topic page of a project that has no _index, and stops once the overview exists", () => {
    mkdirSync(join(cfg.wikiDir, "projects", "alpha"), { recursive: true });
    writeFileSync(join(cfg.wikiDir, "projects", "alpha", "overview.md"), page("Alpha overview", "## Overview\n\no\n\n## Related\n\n- [[projects/_index]]\n"));
    writeFileSync(join(cfg.wikiDir, "projects", "alpha", "deploy.md"), page("Alpha deploy", "## Steps\n\ns\n\n## Related\n\n- [[projects/_index]]\n"));
    const warned = lintAll(cfg).filter((i) => i.rule === "project-no-overview");
    expect(warned.map((i) => i.id).sort()).toEqual(["projects/alpha/deploy", "projects/alpha/overview"]);
    expect(warned[0]).toMatchObject({ level: "warning" });
    expect(warned[0].message).toContain("projects/alpha/_index");
    writeFileSync(join(cfg.wikiDir, "projects", "alpha", "_index.md"), page("Alpha", "## Overview\n\no\n\n## Environment\n\ne\n\n## Wiki pages used by this project\n\n- [[howto/_index]]\n\n## Project-only notes\n\n- n\n\n## Related\n\n- [[projects/_index]]\n"));
    expect(lintAll(cfg).filter((i) => i.rule === "project-no-overview")).toEqual([]);
  });
});
