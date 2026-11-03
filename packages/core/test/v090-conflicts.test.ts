import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addAsset, listConflictFiles, patchMeta, resolveConfig, syncAll, upsertPage, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, sh } from "./helpers.js";

/**
 * 0.9 core audit C1 / H4: a conflicted attachment used to be rewritten as UTF-8 text (or deleted when over
 * git's 1 MiB stdout buffer) with "conflicts: []" in the report; a second conflict on one page from the same
 * host overwrote the first conflict copy.
 */
const howto = (n: string) => `## Prerequisites\n\n${n}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;
const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(n)]);

describe("conflicting attachments", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  let B: WikiConfig;
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "a", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
    B = { ...resolveConfig({ root: m.b, agent: "b", session: "sess-b" }), hostname: "machine-b", autoPullMinutes: 0 };
    upsertPage(A, { id: "howto/diagram-page", title: "Diagram", summary: "Diagram page.", tags: ["wiki"], body: howto("d"), force: true });
    syncAll(B);
  });
  afterEach(() => m.cleanup());

  for (const [label, size] of [["4 KB", 4000], ["1.5 MB (over git's default stdout buffer)", 1_500_000]] as const) {
    it(`both versions survive byte for byte: ${label}`, () => {
      const bytesA = png(size);
      const bytesB = png(size);
      const srcA = join(m.a, "..", `x-${process.pid}.png`);
      writeFileSync(srcA, bytesA);
      addAsset(A, { id: "howto/diagram-page", file: srcA, force: true }); // pushed as wiki/_assets/howto/diagram-page/x-<pid>.png
      const name = `x-${process.pid}.png`;
      const dirB = join(m.b, "wiki", "_assets", "howto", "diagram-page");
      mkdirSync(dirB, { recursive: true });
      writeFileSync(join(dirB, name), bytesB);
      sh(m.b, "git", ["add", "-A"]);
      sh(m.b, "git", ["commit", "-qm", "wiki: asset on B"]);
      const r = syncAll(B);
      expect(readFileSync(join(dirB, name)).equals(bytesA)).toBe(true);
      const copy = `x-${process.pid}.conflict-machine-b.png`;
      expect(readFileSync(join(dirB, copy)).equals(bytesB)).toBe(true);
      expect(r.conflicts).toContain(`wiki/_assets/howto/diagram-page/${copy}`);
      expect(listConflictFiles(B)).toContain(`wiki/_assets/howto/diagram-page/${copy}`);
      expect(r.messages.join("\n")).not.toContain("(none)");
    });
  }
});

describe("repeated conflicts on one page from one host", () => {
  let m: ReturnType<typeof makeTwoMachines>;
  let A: WikiConfig;
  let B: WikiConfig;
  beforeEach(() => {
    m = makeTwoMachines();
    A = { ...resolveConfig({ root: m.a, agent: "a", session: "sess-a" }), hostname: "machine-a", autoPullMinutes: 0 };
    B = { ...resolveConfig({ root: m.b, agent: "b", session: "sess-b" }), hostname: "machine-b", autoPullMinutes: 0 };
    upsertPage(A, { id: "howto/shared", title: "Shared", summary: "Shared page.", tags: ["wiki"], body: howto("s"), force: true });
    syncAll(B);
  });
  afterEach(() => m.cleanup());

  it("keeps every conflict copy: the second gets a numbered name", () => {
    const fB = join(m.b, "wiki", "howto", "shared.md");
    for (const round of [1, 2]) {
      writeFileSync(fB, readFileSync(fB, "utf8").replace(/^summary: .*$/m, `summary: HAND EDIT ON B round ${round}`));
      patchMeta(A, { id: "howto/shared", summary: `A summary round ${round}` });
      syncAll(B);
    }
    const copies = readdirSync(join(m.b, "wiki", "howto")).filter((n) => n.includes("conflict")).sort();
    expect(copies).toEqual(["shared.conflict-machine-b-2.md", "shared.conflict-machine-b.md"]);
    expect(readFileSync(join(m.b, "wiki", "howto", copies[1]), "utf8")).toContain("round 1");
    expect(readFileSync(join(m.b, "wiki", "howto", copies[0]), "utf8")).toContain("round 2");
    expect(listConflictFiles(B).sort()).toEqual(["wiki/howto/shared.conflict-machine-b-2.md", "wiki/howto/shared.conflict-machine-b.md"]);
    expect(existsSync(join(m.b, "wiki", "howto", "shared.md"))).toBe(true);
  });
});
