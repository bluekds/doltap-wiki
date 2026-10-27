import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cfgFor, makeTwoMachines, sh } from "./helpers.js";
import { pageHistory, patchSection, upsertPage, verifyPage, WikiDb, type WikiConfig } from "../src/index.js";

let m: ReturnType<typeof makeTwoMachines>;
let cfg: WikiConfig;
beforeEach(() => { m = makeTwoMachines(); cfg = cfgFor(m.a, { session: "s-one" }); const db = new WikiDb(cfg); db.reindex(); db.close(); });
afterEach(() => m.cleanup());

const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";

describe("page history", () => {
  it("lists the write tools' commits newest first with action, trailers and note", () => {
    upsertPage(cfg, { id: "howto/hist", title: "H", summary: "History page.", tags: ["wiki"], body, force: true });
    patchSection(cfg, { id: "howto/hist", section: "Steps", content: "1. y\n2. z\n" });
    verifyPage({ ...cfg, session: "s-two" }, { id: "howto/hist", evidence: "ran it on machine b" });
    const h = pageHistory(cfg, "howto/hist");
    expect(h.map((e) => e.action)).toEqual(["verify", "update", "add"]);
    expect(h[0]).toMatchObject({ agent: "test", session: "s-two", note: expect.stringContaining("ran it on machine b") });
    expect(h[1].session).toBe("s-one");
    expect(h[1].note).toBe("section: Steps");
    expect(h[2].subject).toBe("wiki: add howto/hist");
    expect(h[0].rev).toMatch(/^[0-9a-f]{7,}$/);
    expect(Date.parse(h[0].date)).toBeGreaterThan(0);
    expect(pageHistory(cfg, "howto/hist", 1)).toHaveLength(1);
  });

  it("returns an empty list for an unknown page and names hand-made commits as `commit`", () => {
    expect(pageHistory(cfg, "howto/nope")).toEqual([]);
    sh(m.a, "git", ["commit", "-q", "--allow-empty", "-m", "touch"]);
    const h = pageHistory(cfg, "howto/add-wiki-page-manually");
    expect(h[0].action).toBe("commit");
    expect(h[0].subject).toBe("seed");
    expect(h[0].session).toBeUndefined();
  });
});
