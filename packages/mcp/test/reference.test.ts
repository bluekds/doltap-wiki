import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { constraintNotes, describeServer, esc, renderReference, typeLabel } from "../src/reference.js";

/**
 * 0.9: docs/TOOLS.md is generated from the server's own schemas. These tests pin the rendering and fail
 * when the committed file drifts from the code (the fix is `npm run reference`).
 */
const TOOLS_MD = fileURLToPath(new URL("../../../docs/TOOLS.md", import.meta.url));
const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const READ_TOOLS = ["wiki_search", "wiki_get", "wiki_list", "wiki_related", "wiki_history", "wiki_template", "wiki_lint"];

describe("server description", () => {
  it("lists every tool and resource with read-only hints on the read tools", async () => {
    const d = await describeServer();
    expect(d.name).toBe("doltap");
    expect(d.tools.map((t) => t.name).sort()).toEqual(["wiki_add_tag", "wiki_audit", "wiki_deprecate", "wiki_get", "wiki_history", "wiki_lint", "wiki_list", "wiki_patch_section", "wiki_related", "wiki_resolve_conflict", "wiki_search", "wiki_set_meta", "wiki_sync", "wiki_template", "wiki_upsert", "wiki_verify"]);
    expect(d.resources.map((r) => r.uri).sort()).toEqual(["wiki://index", "wiki://protocol", "wiki://tags"]);
    expect(d.instructions).toContain("Search first");
    for (const t of d.tools) expect(!!t.annotations?.readOnlyHint, t.name).toBe(READ_TOOLS.includes(t.name));
  });
});

describe("rendering", () => {
  it("labels types and constraints, hiding the safe-integer bounds of int()", () => {
    expect(typeLabel({ type: "string" })).toBe("string");
    expect(typeLabel({ type: "integer", minimum: 1, maximum: 50 })).toBe("integer");
    expect(typeLabel({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(typeLabel({ type: "string", enum: ["a", "b"] })).toBe("enum");
    expect(constraintNotes({ type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER })).toEqual([]);
    expect(constraintNotes({ type: "integer", minimum: 1, maximum: 50 })).toEqual(["1–50"]);
    expect(constraintNotes({ type: "string", enum: ["x", "y"], maxLength: 200 })).toEqual(["one of `x`, `y`", "at most 200 chars"]);
    expect(constraintNotes({ type: "array", items: { type: "string", pattern: "^a$" }, minItems: 1 })).toEqual(["at least 1 item", "items match `^a$`"]);
    expect(esc("see <category>/_index and `wiki/<id>.md`")).toBe("see &lt;category&gt;/_index and `wiki/<id>.md`");
  });

  it("renders one section per tool with a parameter table", async () => {
    const md = renderReference(await describeServer());
    expect(md).toContain("### wiki_search");
    expect(md).toContain("| `limit` | integer | no | `10` | (1–50) |");
    expect(md).toContain("| `category` | enum | no |  | (one of `howto`, `patterns`, `reference`, `decisions`, `projects`) |");
    expect(md).toContain("**Read a wiki page** (read-only)");
    expect(md).toContain("**Create a wiki page** (writes)");
    expect(md).toContain("| [`wiki_sync`](#wiki_sync) | yes |");
    expect(md).toMatch(/### wiki_sync\n\n[^\n]*\n\n[^\n]*\n\nNo parameters\./);
    expect(md).not.toMatch(/9007199254740991/);
    expect(md).not.toMatch(/[^`&]<category>/);
  });

  it("docs/TOOLS.md is what the server renders now (otherwise run `npm run reference`)", async () => {
    const committed = readFileSync(TOOLS_MD, "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(renderReference(await describeServer()));
  });

  it("doltap-mcp --reference --check exits 1 on a stale file and 0 on the committed one", () => {
    const stale = join(tmpdir(), `doltap-tools-${process.pid}.md`);
    writeFileSync(stale, "# old\n");
    const bad = spawnSync(process.execPath, [MAIN, "--reference", "--check", stale], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("out of date");
    const good = spawnSync(process.execPath, [MAIN, "--reference", "--check", TOOLS_MD], { encoding: "utf8" });
    expect(good.status, good.stderr).toBe(0);
    const print = spawnSync(process.execPath, [MAIN, "--reference"], { encoding: "utf8" });
    expect(print.stdout.startsWith("# MCP tool reference")).toBe(true);
  });
});
