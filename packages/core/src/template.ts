import { existsSync } from "node:fs";
import { readSafe } from "./safe.js";
import { join } from "node:path";
import { CATEGORIES, today, type WikiConfig } from "./config.js";

export function templatePath(cfg: WikiConfig, category: string): string {
  return join(cfg.wikiDir, "_meta", "templates", `${category}.md`);
}

export function getTemplate(cfg: WikiConfig, category: string): string {
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`Unknown category "${category}". Valid: ${CATEGORIES.join(", ")}`);
  }
  const p = templatePath(cfg, category);
  if (!existsSync(p)) throw new Error(`Template missing: ${p}`);
  return readSafe(cfg.root, p).replaceAll("{{date}}", today());
}

/** Section headings (level 2) required for each category, derived from the template itself. */
export function requiredSections(cfg: WikiConfig, category: string): string[] {
  const t = getTemplate(cfg, category);
  return [...t.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()).filter((h) => h !== "Related");
}

export function protocolText(cfg: WikiConfig): string {
  return readSafe(cfg.root, join(cfg.wikiDir, "_meta", "PROTOCOL.md"));
}
