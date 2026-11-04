import { readFileSync } from "node:fs";
import type { Command } from "commander";

/**
 * The command reference (docs/CLI.md) is generated from the commander definitions themselves: every command,
 * its arguments, options, defaults and description, in the order they are registered. Nothing is typed twice,
 * and `--check` fails when the committed file drifts from the code (the fix is `npm run reference`).
 */

/** Escape angle brackets outside code spans so placeholders like <id> survive GitHub's HTML sanitiser. */
export function esc(s: string): string {
  return s.split("`").map((part, i) => (i % 2 ? part : part.replace(/</g, "&lt;").replace(/>/g, "&gt;"))).join("`");
}

const cell = (s: string) => esc(s).replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();

/** `doltap serve client add <name>`: the full invocation of a (sub)command. */
export function fullName(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) parts.unshift(c.name());
  return parts.join(" ");
}

/** Depth-first list of every command with subcommands, parents before children. */
export function allCommands(root: Command): Command[] {
  const out: Command[] = [];
  const walk = (c: Command) => { out.push(c); for (const sub of c.commands) walk(sub); };
  walk(root);
  return out;
}

function argumentRows(cmd: Command): string[] {
  return cmd.registeredArguments.map((a) => {
    const def = a.defaultValue !== undefined ? `\`${JSON.stringify(a.defaultValue)}\`` : "";
    return `| \`${a.name()}${a.variadic ? "..." : ""}\` | ${a.required ? "yes" : "no"} | ${def} | ${cell(a.description)} |`;
  });
}

function optionRows(cmd: Command): string[] {
  return cmd.options
    .filter((o) => !o.hidden)
    .map((o) => {
      const def = o.defaultValue !== undefined && !o.negate ? `\`${JSON.stringify(o.defaultValue)}\`` : "";
      return `| \`${o.flags}\` | ${o.mandatory ? "yes" : "no"} | ${def} | ${cell(o.description)} |`;
    });
}

/** Render the command tree as the markdown committed to docs/CLI.md. */
export function renderCliReference(root: Command): string {
  const commands = allCommands(root);
  const out: string[] = [];
  out.push("# CLI reference");
  out.push("");
  out.push(`Generated from the command definitions by \`npm run reference\` (\`doltap --reference\`); do not edit by hand. \`${root.name()}\` ${root.version() ?? "?"}: ${commands.length - 1} commands.`);
  out.push("");
  out.push(`${esc(root.description().replace(/[^.!?]$/, "$&."))} Global options apply to every command:`);
  out.push("");
  out.push("| Option | Required | Default | Description |");
  out.push("|---|---|---|---|");
  out.push(...optionRows(root));
  out.push("");
  out.push("## Commands");
  out.push("");
  for (const c of commands.slice(1)) out.push(`- [\`${fullName(c)}\`](#${fullName(c).replace(/[^a-z0-9]+/g, "-")})${c.description() ? `: ${esc(firstSentence(c.description()))}` : ""}`);
  out.push("");
  for (const c of commands.slice(1)) {
    const usage = [fullName(c), ...c.registeredArguments.map((a) => (a.required ? `<${a.name()}${a.variadic ? "..." : ""}>` : `[${a.name()}${a.variadic ? "..." : ""}]`))].join(" ");
    out.push(`### \`${usage}\``);
    out.push("");
    if (c.description()) { out.push(esc(c.description())); out.push(""); }
    const args = argumentRows(c);
    if (args.length) {
      out.push("| Argument | Required | Default | Description |");
      out.push("|---|---|---|---|");
      out.push(...args);
      out.push("");
    }
    const opts = optionRows(c);
    if (opts.length) {
      out.push("| Option | Required | Default | Description |");
      out.push("|---|---|---|---|");
      out.push(...opts);
      out.push("");
    }
    if (c.commands.length) {
      out.push(`Subcommands: ${c.commands.map((s) => `\`${s.name()}\``).join(", ")}.`);
      out.push("");
    }
  }
  return out.join("\n");
}

function firstSentence(s: string): string {
  const m = /^(.*?[.:;])\s/.exec(s);
  return (m ? m[1] : s).replace(/[.:;]$/, "");
}

/**
 * `doltap --reference [--check <file>]`: print the reference, or compare it with a committed file and
 * return the exit code (0 same, 1 differs). Writes diagnostics to stderr like the MCP variant.
 */
export function cliReference(root: Command, argv: string[]): number {
  const md = renderCliReference(root) + "\n";
  const i = argv.indexOf("--check");
  const check = i >= 0 ? argv[i + 1] : undefined;
  if (!check) {
    process.stdout.write(md);
    return 0;
  }
  let current = "";
  try { current = readFileSync(check, "utf8"); } catch { /* missing counts as stale */ }
  if (current === md) return 0;
  process.stderr.write(`${check} is out of date: run \`npm run reference\` and commit the result\n`);
  return 1;
}
