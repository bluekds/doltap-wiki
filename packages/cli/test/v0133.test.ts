import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTwoMachines } from "../../core/test/helpers.js";

/** 0.13.3: the search snippet line printed a doubled ellipsis ("…  … text") when the match was mid-page, and a stray one when it was at the start. */
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const cli = (args: string[], input = "") => execFileSync(process.execPath, ["--import", "tsx", MAIN, ...args], { cwd: REPO, encoding: "utf8", input, env: { ...process.env, DOLTAP_NO_SYNC: "1" } }).trim();
const filler = Array.from({ length: 40 }, (_, k) => `filler line ${k} about nothing in particular`).join("\n");
const body = `## Prerequisites\n\n${filler}\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- the zanzibar quirk breaks the build\n\n## Related\n\n- [[howto/_index]]\n`;

let m: ReturnType<typeof makeTwoMachines>;
beforeEach(() => { m = makeTwoMachines(); });
afterEach(() => m.cleanup());

describe("search snippet line", () => {
  it("shows one ellipsis for a mid-page match", () => {
    cli(["--root", m.a, "add", "howto/zanzibar-quirk", "--title", "A build quirk", "--summary", "Something about builds.", "--tags", "ci", "--force", "--stdin"], body);
    const out = cli(["--root", m.a, "search", "zanzibar"]);
    const line = out.split("\n").find((l) => l.includes("zanzibar") && l.startsWith("    "))!;
    expect(line).toBeDefined();
    expect(line).not.toMatch(/…\s+…/);
    expect(line.trimStart().startsWith("…")).toBe(true);
  });
});
