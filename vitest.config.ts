import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Windows CI runners need well over 10 s to init and clone the two-machine git fixtures.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
