import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Per-machine state lives under $DOLTAP_STATE_HOME/<wiki-id>; tests must never write into the developer's real
// ~/.local/state/doltap, so every worker (and every CLI subprocess) gets one throwaway home for the run.
const stateHome = mkdtempSync(join(tmpdir(), "doltap-test-state-"));

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Windows CI runners need well over 10 s to init and clone the two-machine git fixtures.
    testTimeout: 60000,
    hookTimeout: 60000,
    env: { DOLTAP_STATE_HOME: stateHome },
    globalSetup: ["./test/global-setup.ts"],
  },
});
