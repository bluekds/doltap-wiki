import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * MCP registration for agent clients other than Claude Code. Each client keeps its servers in a file
 * under the home directory; we add or replace one entry named `doltap` and leave the rest untouched.
 * Claude Code is handled in cli.ts through the `claude mcp` CLI.
 */
export type FileClient = "codex" | "cursor" | "gemini";
export const FILE_CLIENTS: FileClient[] = ["codex", "cursor", "gemini"];
export const ALL_CLIENTS = ["claude", ...FILE_CLIENTS, "generic"] as const;

export interface StdioSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RegisterInput {
  /** Local stdio server (needs the clone) … */
  stdio?: StdioSpec;
  /** … or the always-on HTTPS endpoint (with the path token in the URL). Exactly one of the two. */
  remoteUrl?: string;
  home?: string;
}

export interface RegisterResult {
  file: string;
  /** What was written (or would be, with dryRun). */
  summary: string;
  /** Where the instruction section went, when the client has a global instruction file. */
  instructionsFile?: string;
  /** Text the user must paste by hand (clients without a global instruction file). */
  manual?: string;
}

export function configPath(client: FileClient, home = homedir()): string {
  switch (client) {
    case "codex": return join(home, ".codex", "config.toml");
    case "cursor": return join(home, ".cursor", "mcp.json");
    case "gemini": return join(home, ".gemini", "settings.json");
  }
}

export function instructionsPath(client: FileClient, home = homedir()): string | null {
  switch (client) {
    case "codex": return join(home, ".codex", "AGENTS.md");
    case "gemini": return join(home, ".gemini", "GEMINI.md");
    case "cursor": return null; // User Rules live in Cursor's settings UI, not in a file we can edit safely
  }
}

const tomlStr = (s: string) => JSON.stringify(s); // TOML basic strings share JSON's escaping for our values

/** TOML lines for `[mcp_servers.doltap]` (Codex). */
export function codexBlock(i: RegisterInput): string {
  if (i.remoteUrl) return `[mcp_servers.doltap]\nurl = ${tomlStr(i.remoteUrl)}\n`;
  const s = i.stdio!;
  const env = Object.entries(s.env).map(([k, v]) => `${k} = ${tomlStr(v)}`).join("\n");
  return `[mcp_servers.doltap]\ncommand = ${tomlStr(s.command)}\nargs = [${s.args.map(tomlStr).join(", ")}]\n\n[mcp_servers.doltap.env]\n${env}\n`;
}

/** Remove every `[mcp_servers.doltap]` / `[mcp_servers.doltap.*]` table from a config.toml, keeping everything else byte for byte. */
export function stripCodexBlock(toml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) skipping = /^\s*\[mcp_servers\.doltap(\.[^\]]*)?\]\s*(#.*)?$/.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function hasCodexBlock(toml: string): boolean {
  return /^\s*\[mcp_servers\.doltap\]/m.test(toml);
}

/** JSON entry for Cursor (`url`) or Gemini (`httpUrl`) config files. */
export function jsonEntry(client: "cursor" | "gemini", i: RegisterInput): Record<string, unknown> {
  if (i.remoteUrl) return client === "gemini" ? { httpUrl: i.remoteUrl } : { url: i.remoteUrl };
  const s = i.stdio!;
  return { command: s.command, args: s.args, env: s.env };
}

function readJson(p: string): Record<string, unknown> {
  if (!existsSync(p)) return {};
  const text = readFileSync(p, "utf8");
  if (!text.trim()) return {};
  const j = JSON.parse(text) as unknown;
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error(`${p} is not a JSON object`);
  return j as Record<string, unknown>;
}

/** The `## Doltap Wiki` section appended once to a client's global instruction file. */
export function instructionSection(): string {
  return [
    "## Doltap Wiki",
    "",
    "A shared wiki (Doltap Wiki) is available through the `doltap` MCP server (tools `wiki_search`, `wiki_get`, `wiki_upsert`, `wiki_patch_section`, …) and the `doltap` CLI. Before repetitive or cross-project work (deploy, build, release, auth, retry, config, library version questions), run `wiki_search` first. After solving a problem for the second time or finding an undocumented pitfall, record it with `wiki_upsert` or `wiki_patch_section`. The MCP resource `wiki://protocol` has the full rules; read it before writing.",
    "",
  ].join("\n");
}

function appendInstructions(file: string, dryRun: boolean): string {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (existing.includes("## Doltap")) return `keep ${file} (already has a Doltap section)`;
  if (!dryRun) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, existing ? `${existing.trimEnd()}\n\n${instructionSection()}` : `# Global instructions\n\n${instructionSection()}`);
  }
  return `${existing ? "append Doltap section to" : "create"} ${file}`;
}

/** Add or replace the `doltap` server in the client's config file and its instruction file. */
export function register(client: FileClient, i: RegisterInput, dryRun = false): RegisterResult {
  if (!!i.stdio === !!i.remoteUrl) throw new Error("register needs exactly one of stdio or remoteUrl");
  const home = i.home ?? homedir();
  const file = configPath(client, home);
  let summary: string;
  if (client === "codex") {
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    const had = hasCodexBlock(existing);
    const base = stripCodexBlock(existing).trimEnd();
    const next = `${base}${base ? "\n\n" : ""}${codexBlock(i)}`;
    if (!dryRun) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, next); }
    summary = `${had ? "replace" : "add"} [mcp_servers.doltap] in ${file}`;
  } else {
    const cfg = readJson(file);
    const servers = (cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {}) as Record<string, unknown>;
    const had = "doltap" in servers;
    servers.doltap = jsonEntry(client, i);
    cfg.mcpServers = servers;
    if (!dryRun) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n"); }
    summary = `${had ? "replace" : "add"} mcpServers.doltap in ${file}`;
  }
  const ip = instructionsPath(client, home);
  const r: RegisterResult = { file, summary };
  if (ip) { r.instructionsFile = ip; r.summary += `; ${appendInstructions(ip, dryRun)}`; }
  else r.manual = `Cursor has no global instruction file; paste this into Cursor Settings → Rules → User Rules:\n\n${instructionSection()}`;
  return r;
}

/** Remove the `doltap` server from the client's config file. Instruction sections are left for the user. */
export function unregister(client: FileClient, home = homedir()): string {
  const file = configPath(client, home);
  if (!existsSync(file)) return `${file} does not exist; nothing to remove`;
  if (client === "codex") {
    const existing = readFileSync(file, "utf8");
    if (!hasCodexBlock(existing)) return `no [mcp_servers.doltap] in ${file}`;
    writeFileSync(file, stripCodexBlock(existing).trimEnd() + "\n");
    return `removed [mcp_servers.doltap] from ${file}`;
  }
  const cfg = readJson(file);
  const servers = cfg.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !("doltap" in servers)) return `no mcpServers.doltap in ${file}`;
  delete servers.doltap;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return `removed mcpServers.doltap from ${file}`;
}

export interface Registration {
  client: FileClient;
  file: string;
  /** "stdio", "http", or null when not registered. */
  transport: "stdio" | "http" | null;
}

/** What each file-configured client currently has, without touching anything. */
export function registrations(home = homedir()): Registration[] {
  return FILE_CLIENTS.map((client) => {
    const file = configPath(client, home);
    let transport: Registration["transport"] = null;
    try {
      if (existsSync(file)) {
        if (client === "codex") {
          const text = readFileSync(file, "utf8");
          if (hasCodexBlock(text)) transport = /^\s*url\s*=/m.test(stripOthers(text)) ? "http" : "stdio";
        } else {
          const entry = (readJson(file).mcpServers as Record<string, Record<string, unknown>> | undefined)?.doltap;
          if (entry) transport = "url" in entry || "httpUrl" in entry ? "http" : "stdio";
        }
      }
    } catch { /* unreadable config: report as not registered */ }
    return { client, file, transport };
  });
}

/** Keep only the `[mcp_servers.doltap]` table (the inverse of stripCodexBlock), for inspection. */
function stripOthers(toml: string): string {
  const out: string[] = [];
  let keeping = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) keeping = /^\s*\[mcp_servers\.doltap\]/.test(line);
    if (keeping) out.push(line);
  }
  return out.join("\n");
}

/** Snippets for any other MCP client: a stdio entry and an HTTP entry in the common `mcpServers` shape. */
export function genericSnippets(stdio: StdioSpec, remoteUrl: string | null): { stdio: string; http: string | null } {
  return {
    stdio: JSON.stringify({ mcpServers: { doltap: { command: stdio.command, args: stdio.args, env: stdio.env } } }, null, 2),
    http: remoteUrl ? JSON.stringify({ mcpServers: { doltap: { url: remoteUrl } } }, null, 2) : null,
  };
}
