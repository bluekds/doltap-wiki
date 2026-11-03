import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry, AuditReport } from "./audit.js";
import type { WikiConfig } from "./config.js";
import { commitAndPush, type SyncReport } from "./git.js";
import { withWriteLock } from "./lock.js";

/** Weekly audit reports shared through git: wiki/_meta/reports/<date>.md (not pages: the index and lint skip _meta). */
export function reportsDir(cfg: WikiConfig): string {
  return join(cfg.wikiDir, "_meta", "reports");
}

const REPORT_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

function entryLine(e: AuditEntry): string {
  const bits = [`\`${e.id}\``, `updated ${e.updated}`];
  if (e.verifiedOn) bits.push(`verified ${e.verifiedOn}`);
  if (e.reviewBy) bits.push(`review_by ${e.reviewBy}`);
  bits.push(`reads ${e.reads}`);
  if (e.lastRead) bits.push(`last ${e.lastRead}`);
  return `- ${bits.join(" · ")}`;
}

function section(title: string, hint: string, lines: string[]): string {
  return `## ${title} (${lines.length})\n\n${hint}\n\n${lines.length ? lines.join("\n") : "- none"}\n`;
}

/** The audit as a markdown document a maintainer (human or agent) can read a week later. Nothing in it is an instruction to delete. */
export function renderAuditReport(r: AuditReport): string {
  const t = r.thresholds;
  const head = [
    `# Wiki audit ${r.generated.slice(0, 10)}`,
    "",
    `Hosts reporting: ${r.hostsReporting.join(", ") || "(none)"}. Thresholds: unreferenced ${t.unreferencedDays} days, review window ${t.reviewDays === null ? "per category (reference 180, howto 365)" : `${t.reviewDays} days`}, draft ${t.draftDays} days.`,
    "",
    `Needs attention: ${r.unreviewed.length} unreviewed, ${r.unreferenced.length} unreferenced, ${r.lingeringDrafts.length} lingering drafts, ${r.orphans.length} orphans, ${r.deprecatedStillLinked.length} deprecated-but-linked, ${r.conflictFiles.length} conflict files, ${r.unusedTags.length} unused tags, ${r.searchMisses.length} search misses.`,
    "",
    "Deprecate, merge and delete need a human decision; this report only lists candidates.",
    "",
  ];
  const parts = [
    section("Unreviewed", "Re-check each page against its sources, then `doltap verify` (or `wiki_verify`) with the evidence; set `review_by` from how volatile the subject is.", r.unreviewed.map(entryLine)),
    section("Unreferenced", "Nobody read these within the window. A discoverability check, not a deprecation list: fix the title, summary, tags or hub links.", r.unreferenced.map(entryLine)),
    section("Lingering drafts", "Verify with evidence, or deprecate with a reason.", r.lingeringDrafts.map(entryLine)),
    section("Orphans", "Not linked from any hub or page.", r.orphans.map((id) => `- \`${id}\``)),
    section("Deprecated but still linked", "Point the linking pages at `replaced_by`.", r.deprecatedStillLinked.map((d) => `- \`${d.id}\` <- ${d.linkedFrom.map((l) => `\`${l}\``).join(", ")}`)),
    section("Conflict files", "Merge with `doltap resolve` / `wiki_resolve_conflict`.", r.conflictFiles.map((f) => `- \`${f}\``)),
    section("Unused tags", "Remove with `doltap tags remove` or use them.", r.unusedTags.map((t) => `- \`${t}\``)),
    section("Most read", "Keep these accurate first.", r.mostRead.map(entryLine)),
    `## Search misses (${r.searchMisses.length} of ${r.searchCount} searches on this host)\n\nReword the title or summary of the page that was opened, or add a page.\n\n${r.searchMisses.length ? r.searchMisses.map((m) => `- "${m.query}" -> opened \`${m.opened}\` (${m.rank ? `rank ${m.rank}` : "not returned"}) x${m.count}, last ${m.last}`).join("\n") : "- none"}\n`,
  ];
  return head.join("\n") + "\n" + parts.join("\n");
}

export interface WriteReportOptions {
  /** How many dated reports to keep in wiki/_meta/reports (older ones are removed and committed away). */
  keep?: number;
}

export interface WrittenReport {
  /** Root-relative path of the report written (one per day; a second run the same day overwrites it). */
  file: string;
  /** Older report file names removed to stay within `keep`. */
  removed: string[];
  sync: SyncReport;
}

/** Write the report for `r.generated`, prune old ones, commit and push like a stats file. */
export function writeAuditReport(cfg: WikiConfig, r: AuditReport, o: WriteReportOptions = {}): WrittenReport {
  const keep = Math.max(1, o.keep ?? 12);
  return withWriteLock(cfg, () => {
    const dir = reportsDir(cfg);
    mkdirSync(dir, { recursive: true });
    const day = r.generated.slice(0, 10);
    const name = `${day}.md`;
    writeFileSync(join(dir, name), renderAuditReport(r));
    const all = readdirSync(dir).filter((f) => REPORT_FILE_RE.test(f)).sort();
    const removed = all.slice(0, Math.max(0, all.length - keep)).filter((f) => f !== name);
    for (const f of removed) if (existsSync(join(dir, f))) unlinkSync(join(dir, f));
    const rel = (f: string) => join("wiki", "_meta", "reports", f);
    const sync = commitAndPush(cfg, [rel(name), ...removed.map(rel)], `wiki: audit report ${day}\n\n[host:${cfg.hostname}] [agent:${cfg.agent}]${cfg.session ? ` [session:${cfg.session}]` : ""}`);
    return { file: rel(name), removed, sync };
  });
}
