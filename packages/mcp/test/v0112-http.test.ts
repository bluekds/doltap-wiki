import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, type WikiConfig } from "@bluekds/doltap-core";
import { startHttpServer } from "../src/http.js";

/** 0.11.2, independent audit finding 05: `/healthz` answered before the Host check, so a rebinding page could probe it. */
const TOKEN = "ab".repeat(32);
let dir: string;
let cfg: WikiConfig;
let srv: Awaited<ReturnType<typeof startHttpServer>>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "doltap-http-"));
  cpSync(fileURLToPath(new URL("../../core/test/fixtures/wiki/", import.meta.url)), join(dir, "wiki"), { recursive: true });
  cfg = resolveConfig({ root: dir, noSync: true, agent: "test" });
  srv = await startHttpServer(cfg, { port: 0, host: "127.0.0.1", token: TOKEN });
});
afterAll(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const getWithHost = (path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: srv.port, path, method: "GET", setHost: false, headers: { host } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", reject);
    req.end();
  });

describe("/healthz", () => {
  it("is subject to the same Host check as everything else", async () => {
    expect(await getWithHost("/healthz", "127.0.0.1")).toBe(200);
    expect(await getWithHost("/healthz", "box.tail1234.ts.net")).toBe(200);
    expect(await getWithHost("/healthz", "evil.example")).toBe(421);
  });
});
