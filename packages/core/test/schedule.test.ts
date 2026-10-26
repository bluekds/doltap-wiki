import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchdPlist, stableNodePath, xmlEscape } from "../src/index.js";

describe("launchd plist", () => {
  it("escapes XML special characters in paths", () => {
    expect(xmlEscape("/Users/a&b/<wiki> \"q\" 'x'")).toBe("/Users/a&amp;b/&lt;wiki&gt; &quot;q&quot; &apos;x&apos;");
    const plist = launchdPlist({ label: "com.doltap.test", program: ["/usr/bin/node", "/Users/a&b/doltap"], env: { DOLTAP_ROOT: "/Users/a&b/<wiki>" }, stdout: "/tmp/o.log", stderr: "/tmp/e.log", keepAlive: true });
    expect(plist).toContain("<string>/Users/a&amp;b/doltap</string>");
    expect(plist).toContain("<string>/Users/a&amp;b/&lt;wiki&gt;</string>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).not.toContain("a&b");
  });

  it("prefers a stable symlink over the versioned Cellar path when both resolve to the same binary", () => {
    const base = mkdtempSync(join(tmpdir(), "doltap-node-"));
    try {
      const cellar = join(base, "Cellar", "node@24", "24.22.1", "bin");
      mkdirSync(cellar, { recursive: true });
      writeFileSync(join(cellar, "node"), "#!/bin/sh\n");
      const opt = join(base, "opt", "node@24", "bin");
      mkdirSync(opt, { recursive: true });
      symlinkSync(join(cellar, "node"), join(opt, "node"));
      const other = join(base, "bin");
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "node"), "#!/bin/sh\n"); // a different binary: must not be chosen
      const exec = join(cellar, "node");
      expect(stableNodePath(exec, [join(other, "node"), join(opt, "node")])).toBe(join(opt, "node"));
      expect(stableNodePath(exec, [join(other, "node")])).toBe(exec);
      expect(stableNodePath(exec, [join(base, "missing", "node")])).toBe(exec);
      expect(realpathSync(join(opt, "node"))).toBe(realpathSync(exec));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
