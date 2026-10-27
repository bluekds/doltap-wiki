import type { WikiConfig } from "./config.js";
import { git, isRepo } from "./git.js";
import { assertPageId, relPathFromId, toPosix } from "./page.js";

export interface HistoryEntry {
  /** Short commit hash; the same value `wiki_get` returns as `rev` for the newest entry. */
  rev: string;
  /** Author date, ISO 8601. */
  date: string;
  /** `add`, `update`, `verify`, `deprecate`, `resolve conflict`, `refresh`, … or `commit` for a hand-made commit. */
  action: string;
  subject: string;
  host?: string;
  agent?: string;
  session?: string;
  /** Free text under the trailers: verify evidence, deprecate reason, patch notes. */
  note?: string;
}

function trailer(body: string, key: string): string | undefined {
  return new RegExp(`\\[${key}:([^\\]\\s]+)\\]`).exec(body)?.[1];
}

/**
 * Commits that touched one page, newest first, as recorded by the write tools (`[host:…] [agent:…] [session:…]`
 * trailers). Follows renames so a project moved into a directory keeps its history.
 */
export function pageHistory(cfg: WikiConfig, id: string, limit = 20): HistoryEntry[] {
  assertPageId(id);
  if (!isRepo(cfg)) return [];
  const rel = "wiki/" + toPosix(relPathFromId(id));
  const res = git(cfg, ["log", `-n${Math.max(1, Math.min(limit, 200))}`, "--follow", "--format=%h%x1f%aI%x1f%s%x1f%b%x1e", "--", rel], { allowFail: true });
  if (!res.ok || !res.stdout) return [];
  return res.stdout
    .split("\x1e")
    .map((rec) => rec.replace(/^\n/, ""))
    .filter((rec) => rec.includes("\x1f"))
    .map((rec) => {
      const [rev, date, subject, body = ""] = rec.split("\x1f");
      const action = /^wiki: ([a-z][a-z ]*?)(?: [A-Za-z_][\w/-]*|,|;|$)/.exec(subject)?.[1] ?? "commit";
      const note = body
        .split("\n")
        .filter((l) => !/^\s*(\[(host|agent|session):[^\]]*\]\s*)+$/.test(l))
        .join("\n")
        .trim();
      const e: HistoryEntry = { rev, date: date.trim(), action, subject };
      const all = `${subject}\n${body}`;
      const host = trailer(all, "host"), agent = trailer(all, "agent"), session = trailer(all, "session");
      if (host) e.host = host;
      if (agent) e.agent = agent;
      if (session) e.session = session;
      if (note) e.note = note;
      return e;
    });
}
