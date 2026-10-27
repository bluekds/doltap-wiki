import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfgFor, makeTwoMachines, sh } from "./helpers.js";
import { addTag, publishHostStats, refreshHubs, removeTag, resolveConflict, syncAll, tagsPath, upsertPage, WikiDb, parseTags, conflictCopiesOf, readPage, type WikiConfig } from "../src/index.js";

let m: ReturnType<typeof makeTwoMachines>;
let A: WikiConfig;
let B: WikiConfig;
beforeEach(() => { m = makeTwoMachines(); A = cfgFor(m.a, { noSync: false, session: "a" }); B = cfgFor(m.b, { noSync: false, session: "b", hostname: "hostb" }); for (const c of [A, B]) { const db = new WikiDb(c); db.reindex(); db.close(); } });
afterEach(() => m.cleanup());

const howto = (x: string) => `## Prerequisites\n\n${x}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n`;

describe("0.3.0 audit: unverified items", () => {
  it("CRLF tags.yaml: add and remove keep one group header and write LF", () => {
    const p = tagsPath(A);
    writeFileSync(p, readFileSync(p, "utf8").replace(/\r?\n/g, "\r\n"));
    addTag({ ...A, noSync: true }, { tag: "crlf-tag", description: "Added on CRLF.", group: "other" });
    const after = readFileSync(p, "utf8");
    expect((after.match(/^other:/gm) ?? []).length).toBe(1);
    expect(after).not.toContain("\r");
    expect(parseTags(after).some((t) => t.tag === "crlf-tag")).toBe(true);
    removeTag({ ...A, noSync: true }, "crlf-tag", []);
    expect(parseTags(readFileSync(p, "utf8")).some((t) => t.tag === "crlf-tag")).toBe(false);
  });

  it("detached HEAD: hub refresh and stats publishing do not commit", () => {
    upsertPage({ ...A, noSync: true }, { id: "howto/det", title: "D", summary: "Detached.", tags: ["wiki"], body: howto("d"), force: true });
    // Remove the hub line by hand so a refresh has something to regenerate.
    const hub = join(A.wikiDir, "howto", "_index.md");
    writeFileSync(hub, readFileSync(hub, "utf8").replace(/^- \[\[howto\/det\]\].*\n/m, ""));
    sh(m.a, "git", ["commit", "-q", "-am", "drop hub line"]);
    sh(m.a, "git", ["checkout", "-q", "--detach"]);
    const head = sh(m.a, "git", ["rev-parse", "HEAD"]);
    expect(() => refreshHubs({ ...A, noSync: true })).toThrow(/detached/);
    const db = new WikiDb(A);
    db.logAccess("howto/det");
    expect(() => publishHostStats({ ...A, noSync: true }, db, { pulled: false, pushed: false, offline: false, conflicts: [], messages: [] })).toThrow(/detached/);
    db.close();
    expect(sh(m.a, "git", ["rev-parse", "HEAD"])).toBe(head);
    expect(existsSync(join(A.wikiDir, "_meta", "stats", `${A.hostname}.json`))).toBe(false);
  });

  it("upstream deleted the page: resolve --take conflict restores it from the copy", () => {
    upsertPage(A, { id: "howto/gone", title: "G", summary: "Will be deleted upstream.", tags: ["wiki"], body: howto("g"), force: true });
    syncAll(B);
    sh(m.b, "git", ["rm", "-q", "wiki/howto/gone.md"]);
    sh(m.b, "git", ["commit", "-q", "-m", "wiki: remove howto/gone"]);
    sh(m.b, "git", ["push", "-q"]);
    // A edits the page offline, then syncs: upstream deletion wins, the local version is saved as a conflict copy.
    upsertPage({ ...A, noSync: true }, { id: "howto/gone", title: "G", summary: "Edited locally.", tags: ["wiki"], body: howto("g2"), replace: true, force: true });
    const s = syncAll(A);
    expect(s.conflicts.join(" ")).toContain("gone.conflict-");
    expect(readPage(A, "howto/gone")).toBeNull();
    expect(conflictCopiesOf(A, "howto/gone")).toHaveLength(1);
    const r = resolveConflict(A, { id: "howto/gone", take: "conflict" });
    expect(r.refused).toBeUndefined();
    expect(r.created).toBe(true);
    expect(readPage(A, "howto/gone")?.meta.summary).toBe("Edited locally.");
    expect(conflictCopiesOf(A, "howto/gone")).toEqual([]);
    expect(sh(m.bare, "git", ["log", "-1", "--format=%s", "main"])).toBe("wiki: resolve conflict howto/gone");
  });

  it("sync reports pushed: true when the hub refresh commit was what got pushed", () => {
    upsertPage(A, { id: "howto/hubbed", title: "H", summary: "Hub member.", tags: ["wiki"], body: howto("h"), force: true });
    syncAll(B);
    // B removes the page without touching the hub; A's sync must regenerate the hub and push that commit.
    sh(m.b, "git", ["rm", "-q", "wiki/howto/hubbed.md"]);
    sh(m.b, "git", ["commit", "-q", "-m", "wiki: remove howto/hubbed"]);
    sh(m.b, "git", ["push", "-q"]);
    const report = syncAll(A);
    const hubs = refreshHubs(A, report);
    expect(hubs).toEqual(["wiki/howto/_index.md"]);
    expect(report.pushed).toBe(true);
    expect(sh(m.bare, "git", ["log", "-1", "--format=%s", "main"])).toBe("wiki: refresh hub lists");
  });
});
