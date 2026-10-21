import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { WikiConfig } from "./config.js";

export interface TagInfo {
  tag: string;
  group: string;
  description: string;
}

export function loadTags(cfg: WikiConfig): TagInfo[] {
  const raw = readFileSync(join(cfg.wikiDir, "_meta", "tags.yaml"), "utf8");
  const doc = parse(raw) as Record<string, Record<string, string>>;
  const out: TagInfo[] = [];
  for (const [group, tags] of Object.entries(doc ?? {})) {
    for (const [tag, description] of Object.entries(tags ?? {})) out.push({ tag, group, description: String(description) });
  }
  return out;
}

export function allowedTagSet(cfg: WikiConfig): Set<string> {
  return new Set(loadTags(cfg).map((t) => t.tag));
}
