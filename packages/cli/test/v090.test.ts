import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { join } from "node:path";
import { register } from "../src/integrations.js";
import { maskToken } from "../src/mask.js";

/** 0.9 security audit S7 / S8: the connector URL never reaches a terminal unmasked; integration configs holding it are private. */
const HEX = "ab".repeat(32);

describe("maskToken", () => {
  it("masks the connector URL, a bare path token and upper-case hex, in any message", () => {
    expect(maskToken(`https://x.ts.net/${HEX}/mcp`)).toBe("https://x.ts.net/<token>/mcp");
    expect(maskToken(`Command failed: claude mcp add -s user --transport http doltap https://x.ts.net/${HEX}/mcp`)).not.toContain(HEX);
    expect(maskToken(`path /${HEX} seen`)).toBe("path /<token> seen");
    expect(maskToken(`/${HEX.toUpperCase()}/mcp`)).toBe("/<token>/mcp");
    expect(maskToken("/abc/mcp and 0123456789abcdef")).toBe("/abc/mcp and 0123456789abcdef");
  });
});

describe("integration config files that hold the token URL", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "doltap-home-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it.skipIf(platform() === "win32")("are created mode 0600 for codex, cursor and gemini", () => {
    const url = `https://x.ts.net/${HEX}/mcp`;
    for (const client of ["codex", "cursor", "gemini"] as const) {
      const r = register(client, { remoteUrl: url, home });
      expect(statSync(r.file).mode & 0o777).toBe(0o600);
      expect(readFileSync(r.file, "utf8")).toContain(HEX);
    }
  });
});
