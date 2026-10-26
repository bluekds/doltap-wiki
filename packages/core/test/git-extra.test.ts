import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSyncState, redactCredentials, resolveConfig, search, type WikiConfig } from "../src/index.js";
import { makeTwoMachines, sh } from "./helpers.js";

let m: ReturnType<typeof makeTwoMachines>;
let A: WikiConfig;
beforeEach(() => {
  m = makeTwoMachines();
  A = { ...resolveConfig({ root: m.a, agent: "test-a" }), hostname: "machine-a", autoPullMinutes: 10 };
});
afterEach(() => m.cleanup());

describe("auto-pull backoff", () => {
  it("does not retry a failed pull on every read", () => {
    sh(m.a, "git", ["remote", "set-url", "origin", "ssh://nonexistent.invalid/x.git"]);
    const first = search(A, "obsidian");
    expect(first.sync.offline || first.sync.messages.length > 0).toBe(true);
    expect(readSyncState(A).lastPullAttempt).toBeTruthy();
    const second = search(A, "obsidian");
    expect(second.sync.offline).toBe(false);
    expect(second.sync.messages).toEqual([]);
    expect(second.hits.length).toBeGreaterThan(0);
  });
});

describe("redactCredentials", () => {
  it("masks userinfo in URLs inside git messages", () => {
    expect(redactCredentials("fatal: unable to access 'https://user:s3cret@example.com/x.git/'")).toBe("fatal: unable to access 'https://***@example.com/x.git/'");
    expect(redactCredentials("plain text")).toBe("plain text");
  });
});
