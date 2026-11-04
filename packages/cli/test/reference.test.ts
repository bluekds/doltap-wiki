import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { allCommands, esc, fullName, renderCliReference } from "../src/reference.js";

/** 0.11: docs/CLI.md is generated from the commander definitions; the committed file must match the code. */
const CLI_MD = fileURLToPath(new URL("../../../docs/CLI.md", import.meta.url));
const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function sample(): Command {
  const p = new Command().name("tool").description("A tool.").version("1.2.3").option("--json", "machine-readable output");
  p.command("get <id>").description("read one thing. Longer text.").option("-s, --section <name>", "one section only");
  const serve = p.command("serve").description("services");
  serve.command("install").option("--port <n>", "listen port", "8765").requiredOption("--host <h>", "bind address");
  p.command("add <id> [tags...]").description("add things").option("--no-sync", "do not push");
  return p;
}

describe("rendering", () => {
  it("walks every command in registration order with full names", () => {
    const names = allCommands(sample()).map(fullName);
    expect(names).toEqual(["tool", "tool get", "tool serve", "tool serve install", "tool add"]);
    expect(esc("see <id> and `wiki/<id>.md`")).toBe("see &lt;id&gt; and `wiki/<id>.md`");
  });

  it("renders arguments, options, defaults, required flags and subcommands", () => {
    const md = renderCliReference(sample());
    expect(md).toContain("`tool` 1.2.3: 4 commands");
    expect(md).toContain("| `--json` | no |  | machine-readable output |");
    expect(md).toContain("- [`tool get`](#tool-get): read one thing");
    expect(md).toContain("### `tool get <id>`");
    expect(md).toContain("| `id` | yes |  |  |");
    expect(md).toContain("| `-s, --section <name>` | no |  | one section only |");
    expect(md).toContain("### `tool serve install`");
    expect(md).toContain("| `--port <n>` | no | `\"8765\"` | listen port |");
    expect(md).toContain("| `--host <h>` | yes |  | bind address |");
    expect(md).toContain("### `tool add <id> [tags...]`");
    expect(md).toContain("| `tags...` | no |  |  |");
    expect(md).toContain("| `--no-sync` | no |  | do not push |");
    expect(md).toContain("Subcommands: `install`.");
  });
});

describe("docs/CLI.md", () => {
  it("is what the CLI renders now (otherwise run `npm run reference`)", () => {
    const r = spawnSync(process.execPath, [MAIN, "--reference"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(readFileSync(CLI_MD, "utf8"));
    expect(r.stdout).toContain("### `doltap serve client add <name>`");
    expect(r.stdout).toContain("### `doltap init`");
  });

  it("--check exits 1 on a stale file and 0 on the committed one", () => {
    const stale = join(tmpdir(), `doltap-cli-stale-${process.pid}.md`);
    writeFileSync(stale, "# old\n");
    expect(spawnSync(process.execPath, [MAIN, "--reference", "--check", stale], { encoding: "utf8" }).status).toBe(1);
    expect(spawnSync(process.execPath, [MAIN, "--reference", "--check", CLI_MD], { encoding: "utf8" }).status).toBe(0);
  });
});
