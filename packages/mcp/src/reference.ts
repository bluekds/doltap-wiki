import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { WikiConfig } from "@bluekds/doltap-core";
import { createServer } from "./server.js";

/**
 * The tool reference (docs/TOOLS.md) is generated from the server itself: a client connects over an
 * in-memory transport, lists tools and resources, and the JSON schemas the SDK derives from the zod
 * input schemas are rendered as markdown. Nothing is typed twice, and a test fails when the committed
 * file drifts from the code.
 */
export interface ServerDescription {
  name: string;
  version: string;
  instructions: string;
  tools: Tool[];
  resources: Resource[];
}

/** Connect to a server built on a stub config (no handler runs during listing) and read its catalogue. */
export async function describeServer(): Promise<ServerDescription> {
  // Handlers are only invoked by tool calls; listing never touches the wiki, so no real config is needed.
  const server = createServer({ agent: "reference", session: "reference" } as unknown as WikiConfig);
  const client = new Client({ name: "doltap-reference", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const v = client.getServerVersion();
    return {
      name: v?.name ?? "doltap",
      version: v?.version ?? "?",
      instructions: client.getInstructions() ?? "",
      tools: (await client.listTools()).tools,
      resources: (await client.listResources()).resources,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

type Schema = Record<string, unknown>;

/** Escape angle brackets outside code spans, so placeholders like <category> survive GitHub's HTML sanitiser. */
export function esc(s: string): string {
  return s.split("`").map((part, i) => (i % 2 ? part : part.replace(/</g, "&lt;").replace(/>/g, "&gt;"))).join("`");
}

const cell = (s: string) => esc(s).replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();

const SAFE = Number.MAX_SAFE_INTEGER;

/** A short type label for one JSON-schema property: `string`, `integer`, `string[]`, `enum`. */
export function typeLabel(p: Schema): string {
  if (Array.isArray(p.enum)) return "enum";
  if (Array.isArray(p.anyOf) || Array.isArray(p.oneOf)) {
    const alts = ((p.anyOf ?? p.oneOf) as Schema[]).map(typeLabel).filter((t) => t !== "null");
    return [...new Set(alts)].join(" or ");
  }
  const t = Array.isArray(p.type) ? (p.type as string[]).filter((x) => x !== "null")[0] : p.type;
  if (t === "array") return `${typeLabel((p.items as Schema | undefined) ?? {})}[]`;
  if (t === "integer") return "integer";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "string") return "string";
  if (t === "object") return "object";
  return "any";
}

/** Constraints worth showing next to the description: enum values, ranges, length, pattern. */
export function constraintNotes(p: Schema): string[] {
  const out: string[] = [];
  if (Array.isArray(p.enum)) out.push(`one of ${(p.enum as unknown[]).map((v) => `\`${String(v)}\``).join(", ")}`);
  const items = p.items as Schema | undefined;
  if (items && Array.isArray(items.enum)) out.push(`items one of ${(items.enum as unknown[]).map((v) => `\`${String(v)}\``).join(", ")}`);
  // z.number().int() carries the safe-integer bounds; those are not a constraint anyone chose.
  const min = typeof p.minimum === "number" && p.minimum > -SAFE ? p.minimum : undefined;
  const max = typeof p.maximum === "number" && p.maximum < SAFE ? p.maximum : undefined;
  if (min !== undefined && max !== undefined) out.push(`${min}–${max}`);
  else if (min !== undefined) out.push(`≥ ${min}`);
  else if (max !== undefined) out.push(`≤ ${max}`);
  if (typeof p.minItems === "number" && p.minItems > 0) out.push(`at least ${p.minItems} item${p.minItems > 1 ? "s" : ""}`);
  if (typeof p.minLength === "number" && p.minLength > 0) out.push(`at least ${p.minLength} chars`);
  if (typeof p.maxLength === "number") out.push(`at most ${p.maxLength} chars`);
  if (typeof p.pattern === "string") out.push(`matches \`${p.pattern}\``);
  if (items && typeof items.pattern === "string") out.push(`items match \`${items.pattern}\``);
  return out;
}

function paramRows(schema: Schema): string[] {
  const props = (schema.properties ?? {}) as Record<string, Schema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const rows: string[] = [];
  for (const [name, p] of Object.entries(props)) {
    const notes = constraintNotes(p);
    const desc = [typeof p.description === "string" ? p.description : "", notes.length ? `(${notes.join("; ")})` : ""].filter(Boolean).join(" ");
    const def = "default" in p ? `\`${JSON.stringify(p.default)}\`` : "";
    rows.push(`| \`${name}\` | ${typeLabel(p)} | ${required.has(name) ? "yes" : "no"} | ${def} | ${cell(desc)} |`);
  }
  return rows;
}

/** Render the catalogue as the markdown committed to docs/TOOLS.md. */
export function renderReference(d: ServerDescription): string {
  const out: string[] = [];
  out.push("# MCP tool reference");
  out.push("");
  out.push(`Generated from the server's zod schemas by \`npm run reference\` (\`doltap-mcp --reference\`); do not edit by hand. Server \`${d.name}\` ${d.version}: ${d.tools.length} tools, ${d.resources.length} resources.`);
  out.push("");
  out.push("## Server instructions");
  out.push("");
  out.push("What every client receives at connect time:");
  out.push("");
  for (const line of d.instructions.split("\n")) out.push(`> ${line}`);
  out.push("");
  out.push("## Resources");
  out.push("");
  out.push("| URI | Title | Description | Type |");
  out.push("|---|---|---|---|");
  for (const r of d.resources) out.push(`| \`${r.uri}\` | ${cell(r.title ?? r.name)} | ${cell(r.description ?? "")} | \`${r.mimeType ?? ""}\` |`);
  out.push("");
  out.push("## Tools");
  out.push("");
  out.push("Writes: the tool changes the wiki (commits and pushes) and is refused on a read-only token.");
  out.push("");
  out.push("| Tool | Writes | Title |");
  out.push("|---|---|---|");
  for (const t of d.tools) out.push(`| [\`${t.name}\`](#${t.name}) | ${t.annotations?.readOnlyHint ? "" : "yes"} | ${cell(t.title ?? t.annotations?.title ?? "")} |`);
  out.push("");
  for (const t of d.tools) {
    out.push(`### ${t.name}`);
    out.push("");
    const title = t.title ?? t.annotations?.title;
    if (title) out.push(`**${cell(title)}**${t.annotations?.readOnlyHint ? " (read-only)" : " (writes)"}`);
    out.push("");
    if (t.description) { out.push(esc(t.description.trim())); out.push(""); }
    const rows = paramRows(t.inputSchema as unknown as Schema);
    if (rows.length) {
      out.push("| Parameter | Type | Required | Default | Description |");
      out.push("|---|---|---|---|---|");
      out.push(...rows);
    } else {
      out.push("No parameters.");
    }
    out.push("");
  }
  return out.join("\n");
}

export async function toolReference(): Promise<string> {
  return renderReference(await describeServer());
}
