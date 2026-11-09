import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTwoMachines } from "../../core/test/helpers.js";

/** 0.13 CLI: `add --aliases`, `meta --aliases` (replace, "" clears), and search output naming missing terms. */
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const cli = (args: string[], input = "") => execFileSync(process.execPath, ["--import", "tsx", MAIN, ...args], { cwd: REPO, encoding: "utf8", input, env: { ...process.env, DOLTAP_NO_SYNC: "1" } }).trim();
const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";

let m: ReturnType<typeof makeTwoMachines>;
beforeEach(() => { m = makeTwoMachines(); });
afterEach(() => m.cleanup());

describe("aliases and coverage on the command line", () => {
  it("adds, replaces and clears aliases; search names what a hit lacks", () => {
    cli(["--root", m.a, "add", "howto/inference-box", "--title", "Call the inference box", "--summary", "Ports.", "--tags", "api", "--aliases", "DGX Spark, gb10", "--force", "--stdin"], body);
    const first = JSON.parse(cli(["--root", m.a, "--json", "search", "dgx", "spark"])).hits[0];
    expect(first.id).toBe("howto/inference-box");
    expect(first.aliases).toEqual(["DGX Spark", "gb10"]);
    expect(cli(["--root", m.a, "search", "inference", "box", "zebrafish"])).toMatch(/missing: zebrafish/);
    cli(["--root", m.a, "meta", "howto/inference-box", "--aliases", "ai-server"]);
    expect(JSON.parse(cli(["--root", m.a, "--json", "get", "howto/inference-box"])).meta.aliases).toEqual(["ai-server"]);
    cli(["--root", m.a, "meta", "howto/inference-box", "--aliases", ""]);
    expect(JSON.parse(cli(["--root", m.a, "--json", "get", "howto/inference-box"])).meta.aliases).toBeUndefined();
  });
});
