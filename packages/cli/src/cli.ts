import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Read at runtime so `--version` always matches the installed package. */
const PKG_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
import {
  addTag,
  CATEGORIES,
  CONFIDENCE,
  conflictCopiesOf,
  deprecatePage,
  get,
  removeTag,
  resolveConflict,
  verifyPage,
  getTemplate,
  lintAll,
  list,
  listConflictFiles,
  loadTags,
  patchMeta,
  patchSection,
  protocolText,
  syncAll,
  readIndexMd,
  refreshHubs,
  related,
  resolveConfig,
  search,
  upsertPage,
  WikiDb,
  writeIndexMd,
  audit,
  isCategoryHub,
  installSchedule,
  installHttpService,
  httpServiceStatus,
  uninstallHttpService,
  publishHostStats,
  scheduleStatus,
  uninstallSchedule,
  type ConfigOverrides,
  type LintIssue,
  type SyncReport,
  type WikiConfig,
  scaffoldWiki,
  applyUpgrade,
  doctor,
  pageHistory,
  planUpgrade,
  rotateLogs,
  type DoctorCheck,
  runGolden,
} from "@bluekds/doltap-core";

const program = new Command();
program
  .name("doltap")
  .description("Doltap: shared knowledge base for AI agents")
  .version(PKG_VERSION)
  .option("--root <path>", "wiki repository root (default: $DOLTAP_ROOT, nearest ancestor, or ~/.doltap)")
  .option("--agent <name>", "client identity for commit messages (default: $DOLTAP_AGENT or cli)")
  .option("--session <id>", "session id for commit messages")
  .option("--no-sync", "do not pull/push (local only)")
  .option("--json", "machine-readable output");

interface GlobalOpts {
  root?: string;
  agent?: string;
  session?: string;
  sync: boolean;
  json?: boolean;
}

function cfgFrom(): { cfg: WikiConfig; json: boolean } {
  const g = program.opts<GlobalOpts>();
  // Only an explicit --no-sync overrides $DOLTAP_NO_SYNC; commander defaults `sync` to true.
  const o: ConfigOverrides = { root: g.root, agent: g.agent, session: g.session, noSync: g.sync === false ? true : undefined };
  return { cfg: resolveConfig(o), json: !!g.json };
}

function out(json: boolean, data: unknown, human: () => void): void {
  if (json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  else human();
}

function syncNotes(sync: SyncReport): string[] {
  const notes = [...sync.messages];
  if (sync.conflicts.length) notes.push(`CONFLICTS saved: ${sync.conflicts.join(", ")}`);
  return notes;
}

function printChecks(checks: DoctorCheck[], quiet: boolean): void {
  for (const c of checks) {
    if (quiet && (c.status === "ok" || c.status === "skip")) continue;
    console.log(`${c.status.padEnd(4)} ${c.name.padEnd(16)} ${c.detail}`);
    if (c.fix && c.status !== "ok") console.log(`${"".padEnd(21)}-> ${c.fix}`);
  }
}

function printIssues(issues: LintIssue[]): void {
  for (const i of issues) console.log(`${i.level === "error" ? "ERROR" : "warn "} ${i.id}: [${i.rule}] ${i.message}`);
}

function readContent(opts: { content?: string; file?: string; stdin?: boolean }): string {
  if (opts.content !== undefined) return opts.content;
  if (opts.file) return readFileSync(resolve(opts.file), "utf8");
  if (opts.stdin || !process.stdin.isTTY) return readFileSync(0, "utf8");
  throw new Error("provide --content, --file, or pipe content on stdin");
}

function fail(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (program.opts<GlobalOpts>().json) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
  else console.error(`error: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- init
program
  .command("init")
  .description("set up a wiki on this machine: clone an existing wiki repository (--repo) or create a new one (--new)")
  .option("--repo <url>", "git URL of an existing wiki repository to clone")
  .option("--new", "create a new wiki (protocol, templates, hubs, Obsidian config) and git init it")
  .option("--remote <url>", "with --new: add this empty repository as origin and push")
  .option("--dir <path>", "where to clone or create", join(homedir(), ".doltap"))
  .action((o: { repo?: string; new?: boolean; remote?: string; dir: string }) => {
    try {
      const dir = resolve(o.dir);
      if (o.new) {
        const r = scaffoldWiki(dir, { remote: o.remote });
        console.log(`created wiki at ${r.dir} (${r.files} files, 1 commit${r.pushed ? ", pushed" : ""})`);
        for (const n of r.notes) console.log(`note: ${n}`);
      } else if (!existsSync(join(dir, "wiki", "_meta", "PROTOCOL.md"))) {
        if (!o.repo) throw new Error(`no wiki at ${dir}; pass --repo <git-url> to clone one or --new to create one`);
        mkdirSync(resolve(dir, ".."), { recursive: true });
        console.log(`cloning ${o.repo} -> ${dir}`);
        execFileSync("git", ["clone", "--quiet", o.repo, dir], { stdio: "inherit" });
      } else console.log(`existing wiki at ${dir}`);
      const cfg = resolveConfig({ root: dir, noSync: true });
      const db = new WikiDb(cfg);
      const r = db.reindex(true);
      db.close();
      writeIndexMd(cfg);
      console.log(`indexed ${r.total} pages`);
      console.log(`\nnext: export DOLTAP_ROOT=${dir}  (or keep the default ~/.doltap)`);
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- search
program
  .command("search <query...>")
  .description("full-text search (title/summary/tags weighted above body)")
  .option("-c, --category <cat>", `one of ${CATEGORIES.join("|")}`)
  .option("-t, --tag <tag>")
  .option("--confidence <level>", CONFIDENCE.join("|"))
  .option("-n, --limit <n>", "max results", "10")
  .option("--include-deprecated")
  .option("--include-hubs", "also return Home and <category>/_index pages")
  .action((q: string[], o: { category?: string; tag?: string; confidence?: string; limit: string; includeDeprecated?: boolean; includeHubs?: boolean }) => {
    try {
      const { cfg, json } = cfgFrom();
      const { hits, sync } = search(cfg, q.join(" "), { ...o, limit: Number(o.limit) });
      out(json, { hits, sync }, () => {
        if (!hits.length) console.log("no results");
        for (const h of hits) {
          console.log(`${h.id}  [${h.confidence}]  ${h.tags.join(",")}${h.matched.length < WikiDb.queryTokens(q.join(" ")).length ? `  (matched: ${h.matched.join(", ")})` : ""}`);
          console.log(`    ${h.summary}`);
          if (h.snippet && !h.summary.includes(h.snippet.replace(/[\[\]]/g, ""))) console.log(`    … ${h.snippet.replace(/\n/g, " ")}`);
        }
        for (const n of syncNotes(sync)) console.error(`note: ${n}`);
      });
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- get
program
  .command("get <id>")
  .description("print a page (or one section) by id, e.g. howto/deploy-pypi")
  .option("-s, --section <heading>", "only this ## section")
  .option("--meta", "include frontmatter in human output")
  .action((id: string, o: { section?: string; meta?: boolean }) => {
    try {
      const { cfg, json } = cfgFrom();
      const { result, sync } = get(cfg, id, o.section);
      if (!result) throw new Error(`page not found: ${id}`);
      const { page, text, backlinks } = result;
      out(json, { id, rev: page.rev, meta: page.meta, section: o.section ?? null, text, links: page.links, backlinks, sections: page.sections.map((s) => s.heading), sync }, () => {
        if (o.meta || !o.section) {
          console.log(`# ${page.meta.title}`);
          console.log(`id: ${id} | confidence: ${page.meta.confidence} | tags: ${page.meta.tags.join(", ")} | updated: ${page.meta.updated} | rev: ${page.rev}`);
          console.log(`summary: ${page.meta.summary}\n`);
        }
        console.log(text);
        if (!o.section && backlinks.length) console.log(`\nbacklinks: ${backlinks.join(", ")}`);
      });
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- list
program
  .command("list")
  .description("list pages")
  .option("-c, --category <cat>")
  .option("-t, --tag <tag>")
  .option("--confidence <level>")
  .option("--include-deprecated")
  .action((o: { category?: string; tag?: string; confidence?: string; includeDeprecated?: boolean }) => {
    try {
      const { cfg, json } = cfgFrom();
      const { rows, sync } = list(cfg, o);
      const pages = rows.filter((r) => !isCategoryHub(r.id));
      out(json, { pages, sync }, () => {
        for (const r of pages) console.log(`${r.id.padEnd(44)} [${r.confidence}] ${r.summary}`);
      });
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- index / protocol / template / tags
program.command("index").description("print the generated one-line-per-page index").action(() => {
  try { const { cfg } = cfgFrom(); writeIndexMd(cfg); process.stdout.write(readIndexMd(cfg)); } catch (e) { fail(e); }
});
program.command("protocol").description("print _meta/PROTOCOL.md").action(() => {
  try { process.stdout.write(protocolText(cfgFrom().cfg)); } catch (e) { fail(e); }
});
program.command("template <category>").description("print the page template for a category with today's date filled in").action((c: string) => {
  try { process.stdout.write(getTemplate(cfgFrom().cfg, c)); } catch (e) { fail(e); }
});
const tagsCmd = program.command("tags").description("tag vocabulary: list (default), add, remove");
const listTags = () => {
  try {
    const { cfg, json } = cfgFrom();
    const tags = loadTags(cfg);
    out(json, tags, () => { for (const t of tags) console.log(`${t.tag.padEnd(14)} ${t.group.padEnd(9)} ${t.description}`); });
  } catch (e) { fail(e); }
};
tagsCmd.action(listTags);
tagsCmd.command("list").action(listTags);
tagsCmd.command("add <tag> <description...>").description("add a tag to _meta/tags.yaml and commit").option("--group <group>", "group heading (default other)").action((tag: string, description: string[], o: { group?: string }) => {
  try {
    const { cfg, json } = cfgFrom();
    const r = addTag(cfg, { tag, description: description.join(" "), group: o.group });
    out(json, r, () => { console.log(`added tag ${r.tag} (${r.group})`); for (const n of syncNotes(r.sync)) console.log(`note: ${n}`); });
  } catch (e) { fail(e); }
});
tagsCmd.command("remove <tag>").description("remove a tag that no page uses").action((tag: string) => {
  try {
    const { cfg, json } = cfgFrom();
    const usedBy = list(cfg, { includeDeprecated: true, tag }).rows.map((r) => r.id);
    const r = removeTag(cfg, tag, usedBy);
    out(json, r, () => { console.log(`removed tag ${r.tag}`); for (const n of syncNotes(r.sync)) console.log(`note: ${n}`); });
  } catch (e) { fail(e); }
});

// ---------------------------------------------------------------- add
program
  .command("add <id>")
  .description("create a page (id = <category>/<slug>). Body from --file/--stdin or the template.")
  .requiredOption("--title <text>")
  .requiredOption("--summary <text>", "1-2 sentences, max 200 chars")
  .option("--tags <list>", "comma-separated, must exist in _meta/tags.yaml")
  .option("--sources <list>", "comma-separated URLs/ids")
  .option("-f, --file <path>", "markdown body file")
  .option("--stdin", "read body from stdin")
  .option("--force", "create even if similar pages exist")
  .option("--replace", "overwrite an existing page (otherwise an existing id is refused; use patch/meta to edit)")
  .option("--base-rev <rev>", "rev shown by `doltap get`; refused if the page changed since")
  .action((id: string, o: { title: string; summary: string; tags?: string; sources?: string; file?: string; stdin?: boolean; force?: boolean; replace?: boolean; baseRev?: string }) => {
    try {
      const { cfg, json } = cfgFrom();
      const body = o.file || o.stdin ? readContent(o) : undefined;
      const r = upsertPage(cfg, {
        id, title: o.title, summary: o.summary, body, force: o.force, replace: o.replace, baseRev: o.baseRev,
        tags: o.tags ? o.tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        sources: o.sources ? o.sources.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
      out(json, r, () => {
        if (r.refused) {
          console.log(`refused: ${r.refused}`);
          printIssues(r.issues);
          for (const s of r.similar ?? []) console.log(`  similar: ${s.id} — ${s.summary}`);
          process.exitCode = 2;
          return;
        }
        console.log(`${r.created ? "created" : "updated"} ${r.id} (${r.path})`);
        printIssues(r.issues);
        for (const n of syncNotes(r.sync)) console.log(`note: ${n}`);
      });
      if (r.refused && json) process.exitCode = 2;
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- patch
program
  .command("patch <id>")
  .description("replace or append one ## section of a page")
  .requiredOption("-s, --section <heading>")
  .option("--content <text>")
  .option("-f, --file <path>")
  .option("--stdin")
  .option("--append", "append to the section instead of replacing")
  .option("--no-touch", "do not bump the updated date (typo fixes)")
  .option("--create", "add the section when the heading does not exist")
  .option("--base-rev <rev>", "rev shown by `doltap get`; refused if the page changed since")
  .action((id: string, o: { section: string; content?: string; file?: string; stdin?: boolean; append?: boolean; touch: boolean; create?: boolean; baseRev?: string }) => {
    try {
      const { cfg, json } = cfgFrom();
      const r = patchSection(cfg, { id, section: o.section, content: readContent(o), mode: o.append ? "append" : "replace", touch: o.touch, create: o.create, baseRev: o.baseRev });
      out(json, r, () => {
        if (r.refused) { console.log(`refused: ${r.refused}`); printIssues(r.issues); process.exitCode = 2; return; }
        console.log(`updated ${r.id} ## ${o.section}`);
        printIssues(r.issues);
        for (const n of syncNotes(r.sync)) console.log(`note: ${n}`);
      });
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- meta (promote / deprecate / retag)
program
  .command("meta <id>")
  .description("update frontmatter: --add-source, --add-tag, --title, --summary (promote with `doltap verify`, deprecate with `doltap deprecate`)")
  .option("--confidence <level>", "draft (demote); verified needs `doltap verify`, deprecated needs `doltap deprecate`")
  .option("--add-source <s>", "repeatable", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--add-tag <t>", "repeatable", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--title <text>")
  .option("--summary <text>")
  .option("--base-rev <rev>", "rev shown by `doltap get`; refused if the page changed since")
  .action((id: string, o: { confidence?: string; addSource: string[]; addTag: string[]; title?: string; summary?: string; baseRev?: string }) => {
    try {
      const { cfg, json } = cfgFrom();
      const r = patchMeta(cfg, { id, confidence: o.confidence, addSources: o.addSource, addTags: o.addTag, title: o.title, summary: o.summary, baseRev: o.baseRev });
      out(json, r, () => {
        if (r.refused) { console.log(`refused: ${r.refused}`); printIssues(r.issues); process.exitCode = 2; return; }
        console.log(`updated ${r.id} frontmatter`);
        printIssues(r.issues);
        for (const n of syncNotes(r.sync)) console.log(`note: ${n}`);
      });
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- verify / deprecate / resolve
program
  .command("verify <id>")
  .description("promote draft -> verified with evidence (the session that created the page cannot verify it)")
  .requiredOption("--evidence <text>", "what you did, where, and what confirmed it; appended to sources")
  .option("--base-rev <rev>")
  .action((id: string, o: { evidence: string; baseRev?: string }) => {
    try {
      const { cfg, json } = cfgFrom();
      const r = verifyPage(cfg, { id, evidence: o.evidence, baseRev: o.baseRev });
      out(json, r, () => {
        if (r.refused) { console.log(`refused: ${r.refused}`); printIssues(r.issues); process.exitCode = 2; return; }
        console.log(`verified ${r.id}`);
        printIssues(r.issues);
        for (const n of syncNotes(r.sync)) console.log(`note: ${n}`);
      });
    } catch (e) { fail(e); }
  });
program
  .command("deprecate <id>")
  .description("mark a page deprecated and point to its replacement (sets replaced_by, adds a banner, updates the hub)")
  .requiredOption("--replaced-by <id>", "the page to use instead (must exist)")
  .option("--reason <text>")
  .option("--base-rev <rev>")
  .action((id: string, o: { replacedBy: string; reason?: string; baseRev?: string }) => {
    try {
      const { cfg, json } = cfgFrom();
      const r = deprecatePage(cfg, { id, replacedBy: o.replacedBy, reason: o.reason, baseRev: o.baseRev });
      out(json, r, () => {
        if (r.refused) { console.log(`refused: ${r.refused}`); printIssues(r.issues); process.exitCode = 2; return; }
        console.log(`deprecated ${r.id} -> ${o.replacedBy}`);
        printIssues(r.issues);
        for (const n of syncNotes(r.sync)) console.log(`note: ${n}`);
      });
    } catch (e) { fail(e); }
  });
program
  .command("resolve <id>")
  .description("finish a conflict: write the merged body (--file/--stdin) or keep the conflict copy (--take conflict), delete the copies, commit")
  .option("-f, --file <path>", "merged body file")
  .option("--stdin")
  .option("--take <which>", "conflict: use the conflict copy's body as is")
  .option("--base-rev <rev>", "rev shown by `doltap get`; refused if the page changed since")
  .action((id: string, o: { file?: string; stdin?: boolean; take?: string; baseRev?: string }) => {
    try {
      const { cfg, json } = cfgFrom();
      if (!o.take) {
        const copies = conflictCopiesOf(cfg, id);
        if (!copies.length) throw new Error(`no conflict copy for ${id}`);
      }
      const r = resolveConflict(cfg, { id, body: o.take ? undefined : readContent(o), take: o.take === "conflict" ? "conflict" : undefined, baseRev: o.baseRev });
      out(json, r, () => {
        if (r.refused) { console.log(`refused: ${r.refused}`); printIssues(r.issues); process.exitCode = 2; return; }
        console.log(`resolved ${r.id}`);
        printIssues(r.issues);
        for (const n of syncNotes(r.sync)) console.log(`note: ${n}`);
      });
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- related
program.command("history <id>").description("commits that changed a page, newest first (who, when, which action, note)").option("-n, --limit <n>", "entries", "20").action((id: string, o: { limit: string }) => {
  try {
    const { cfg, json } = cfgFrom();
    const entries = pageHistory(cfg, id, Number(o.limit));
    if (!entries.length) throw new Error(`no history for ${id} (unknown page or not committed yet)`);
    out(json, { id, entries }, () => {
      for (const e of entries) {
        console.log(`${e.rev}  ${e.date.slice(0, 16).replace("T", " ")}  ${e.action.padEnd(16)} ${[e.agent, e.host, e.session ? `session ${e.session}` : ""].filter(Boolean).join(" @ ")}`);
        if (e.note) console.log(`    ${e.note.replace(/\n/g, "\n    ")}`);
      }
    });
  } catch (e) { fail(e); }
});

program.command("related <id>").description("outlinks, backlinks, and pages sharing tags").action((id: string) => {
  try {
    const { cfg, json } = cfgFrom();
    const { result } = related(cfg, id);
    out(json, result, () => {
      const show = (label: string, rows: { id: string; summary: string }[]) => {
        console.log(`${label}:`);
        if (!rows.length) console.log("  (none)");
        for (const r of rows) console.log(`  ${r.id} — ${r.summary}`);
      };
      show("outlinks", result.outlinks); show("backlinks", result.backlinks); show("shared tags", result.sharedTags);
    });
  } catch (e) { fail(e); }
});

// ---------------------------------------------------------------- lint
program.command("lint [ids...]").description("validate pages (exit 1 on errors)").action((ids: string[]) => {
  try {
    const { cfg, json } = cfgFrom();
    const issues = lintAll(cfg, ids.length ? ids : undefined);
    const errors = issues.filter((i) => i.level === "error").length;
    out(json, { issues, errors, warnings: issues.length - errors }, () => {
      printIssues(issues);
      console.log(`${errors} error(s), ${issues.length - errors} warning(s)`);
    });
    if (errors) process.exitCode = 1;
  } catch (e) { fail(e); }
});

// ---------------------------------------------------------------- sync / reindex
program.command("sync").description("pull, push pending commits, reindex, refresh hub lists, report conflict files and broken pages").action(() => {
  try {
    const { cfg, json } = cfgFrom();
    const rotated = rotateLogs(cfg);
    const report = syncAll(cfg);
    const hubs = refreshHubs(cfg, report);
    const db = new WikiDb(cfg);
    const r = db.reindex();
    const published = publishHostStats(cfg, db, report);
    db.close();
    writeIndexMd(cfg);
    const conflicts = listConflictFiles(cfg);
    out(json, { ...report, reindexed: r.indexed, removed: r.removed, total: r.total, hubListsRefreshed: hubs, brokenPages: r.broken, statsPublished: published, conflictFiles: conflicts, logsRotated: rotated }, () => {
      console.log(`pulled: ${report.pulled} pushed: ${report.pushed} offline: ${report.offline} | pages: ${r.total} (reindexed ${r.indexed}, removed ${r.removed})${hubs.length ? ` | hub lists refreshed: ${hubs.join(", ")}` : ""}${published ? " | stats published" : ""}`);
      for (const n of syncNotes(report)) console.log(`note: ${n}`);
      if (rotated.length) console.log(`note: rotated logs ${rotated.join(", ")}`);
      for (const b of r.broken) console.log(`BROKEN ${b.relPath}: ${b.error}`);
      if (conflicts.length) console.log(`conflict files needing manual merge:\n  ${conflicts.join("\n  ")}`);
    });
  } catch (e) { fail(e); }
});
program.command("reindex").description("rebuild the local search index and _meta/index.md").option("--full").action((o: { full?: boolean }) => {
  try {
    const { cfg, json } = cfgFrom();
    const db = new WikiDb(cfg);
    const r = db.reindex(!!o.full);
    db.close();
    const p = writeIndexMd(cfg);
    out(json, { ...r, pages: undefined, indexMd: p }, () => {
      console.log(`indexed ${r.indexed}/${r.total} pages, removed ${r.removed}; wrote ${p}`);
      for (const b of r.broken) console.log(`BROKEN ${b.relPath}: ${b.error}`);
    });
  } catch (e) { fail(e); }
});

// ---------------------------------------------------------------- audit
program
  .command("audit")
  .description("report unreferenced, stale, lingering-draft, orphan and deprecated-but-linked pages (uses stats from all hosts)")
  .option("--unreferenced-days <n>", "no reads within N days", "90")
  .option("--stale-days <n>", "updated older than N days", "90")
  .option("--draft-days <n>", "draft created more than N days ago", "30")
  .action((o: { unreferencedDays: string; staleDays: string; draftDays: string }) => {
    try {
      const { cfg, json } = cfgFrom();
      const r = audit(cfg, { unreferencedDays: Number(o.unreferencedDays), staleDays: Number(o.staleDays), draftDays: Number(o.draftDays) });
      out(json, r, () => {
        const section = (title: string, rows: { id: string; reads?: number; updated?: string; lastRead?: string | null }[]) => {
          console.log(`${title} (${rows.length})`);
          for (const e of rows) console.log(`  ${e.id}${e.updated ? `  updated ${e.updated}` : ""}${e.reads !== undefined ? `  reads ${e.reads}` : ""}${e.lastRead ? `  last ${e.lastRead}` : ""}`);
        };
        console.log(`hosts reporting: ${r.hostsReporting.join(", ") || "(none)"}`);
        section("unreferenced -> deprecate candidates", r.unreferenced);
        section("stale -> re-verify", r.stale);
        section("lingering drafts -> verify or deprecate", r.lingeringDrafts);
        section("orphans -> link from a hub or page", r.orphans.map((id) => ({ id })));
        section("deprecated but still linked", r.deprecatedStillLinked.map((d) => ({ id: `${d.id} <- ${d.linkedFrom.join(", ")}` })));
        section("conflict files -> merge (doltap resolve)", r.conflictFiles.map((id) => ({ id })));
        section("unused tags -> doltap tags remove", r.unusedTags.map((id) => ({ id })));
        section("most read", r.mostRead);
        console.log(`search misses (${r.searchMisses.length} of ${r.searchCount} searches on this host) -> reword title/summary or add a page`);
        for (const m of r.searchMisses) console.log(`  "${m.query}" -> opened ${m.opened} (${m.rank ? `rank ${m.rank}` : "not returned"})  x${m.count}  last ${m.last}`);
      });
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- golden
program
  .command("golden [file]")
  .description("run the golden query set (default wiki/_meta/golden.json: [{query, expect}]) and list queries whose page is not first; exit 1 on misses")
  .action((file: string | undefined) => {
    try {
      const { cfg, json } = cfgFrom();
      const r = runGolden(cfg, file ? resolve(file) : undefined);
      out(json, r, () => {
        if (!r.file) { console.log("no golden set: create wiki/_meta/golden.json as a JSON array of {query, expect}"); return; }
        for (const m of r.misses) console.log(`miss  "${m.query}" -> ${m.got.slice(0, 3).join(", ") || "(none)"}  expected ${m.expect}${m.rank ? ` (rank ${m.rank})` : " (not returned)"}${m.note ? `  # ${m.note}` : ""}`);
        console.log(`${r.total - r.misses.length}/${r.total} golden queries first`);
      });
      if (r.misses.length) process.exit(1);
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- doctor
program
  .command("doctor")
  .description("run every health check of the maintenance routine (repo, sync age, services, lint, tags, index, secrets, logs, integration); exit 1 on failures")
  .option("--healthz <url>", "also probe a public /healthz URL (no token in it)")
  .option("--no-services", "skip the scheduler and HTTP service checks")
  .option("--quiet", "print only warnings and failures")
  .action(async (o: { healthz?: string; services: boolean; quiet?: boolean }) => {
    try {
      const { cfg, json } = cfgFrom();
      const r = await doctor(cfg, { services: o.services, healthzUrl: o.healthz, extra: o.services ? integrationChecks() : [] });
      out(json, r, () => {
        printChecks(r.checks, !!o.quiet);
        console.log(`${r.failures} failure(s), ${r.warnings} warning(s) on ${r.host} (${r.root})`);
      });
      if (!r.ok) process.exitCode = 1;
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- upgrade
program
  .command("upgrade")
  .description("compare this wiki with the skeleton shipped in this version; --apply merges .gitignore/.gitattributes lines and replaces Obsidian config and templates, PROTOCOL changes are shown for manual merge")
  .option("--diff", "print unified diffs for differing files")
  .option("--apply", "write the applicable changes and commit them")
  .action((o: { diff?: boolean; apply?: boolean }) => {
    try {
      const { cfg, json } = cfgFrom();
      const plan = planUpgrade(cfg, { diff: !!o.diff });
      const result = o.apply ? applyUpgrade(cfg, plan) : null;
      out(json, { ...plan, result }, () => {
        console.log(`skeleton ${plan.skeletonVersion}`);
        for (const i of plan.items) {
          if (i.status === "same" || (i.class === "page" && i.status === "differs")) continue;
          const what = i.class === "page" ? "example page not in this wiki (optional; see the skeleton in the doltap package)" : i.class === "review" ? "differs; merge by hand (doltap upgrade --diff)" : i.status === "missing" ? "missing; --apply adds it" : i.class === "merge" ? `--apply appends: ${i.addLines?.join(" | ")}` : "differs; --apply replaces it";
          console.log(`${i.status.padEnd(8)} ${i.path.padEnd(44)} ${what}`);
          if (i.diff) console.log(i.diff.trimEnd());
        }
        if (!plan.applicable.length && !plan.review.length) console.log("up to date with the shipped skeleton");
        if (result) {
          console.log(result.applied.length ? `applied: ${result.applied.join(", ")}` : "nothing applied");
          for (const n of syncNotes(result.sync)) console.log(`note: ${n}`);
          if (result.skipped.length) console.log(`left for manual merge: ${result.skipped.join(", ")}`);
        }
      });
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- schedule
const schedule = program.command("schedule").description("periodic `doltap sync` via launchd (macOS) or crontab");
schedule.command("install").option("--every <minutes>", "interval", "10").action((o: { every: string }) => {
  try {
    const { cfg, json } = cfgFrom();
    // Unix: launchd/cron run the `wiki` shim; Windows: schtasks runs node + this JS entry.
    const bin = process.platform === "win32" ? fileURLToPath(import.meta.url) : process.argv[1];
    const r = installSchedule(cfg, bin, Number(o.every));
    out(json, r, () => console.log(`${r.platform}: ${r.detail}`));
  } catch (e) { fail(e); }
});
schedule.command("uninstall").action(() => { try { const r = uninstallSchedule(); out(!!program.opts<GlobalOpts>().json, r, () => console.log(`${r.platform}: ${r.detail}`)); } catch (e) { fail(e); } });
schedule.command("status").action(() => { try { const r = scheduleStatus(); out(!!program.opts<GlobalOpts>().json, r, () => console.log(`${r.platform}: ${r.installed ? "installed" : "not installed"} — ${r.detail}`)); } catch (e) { fail(e); } });

// ---------------------------------------------------------------- serve (always-on HTTP MCP)
const serve = program.command("serve").description("always-on HTTP MCP server for remote clients (claude.ai connectors, other machines)");
/** Mask the 64-hex path token in a connector URL for anything that is printed. */
function maskToken(url: string): string {
  return url.replace(/\/[0-9a-f]{32,}\/mcp\b/g, "/<token>/mcp");
}

/** Create the HTTP path token if missing and keep the file private, before any service reads it. */
function ensureToken(cfg: WikiConfig, rotate = false): string {
  const p = join(cfg.stateDir, "http-token");
  if (rotate || !existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

serve.command("install").option("--port <n>", "listen port", "8765").option("--host <h>", "bind address", "127.0.0.1").option("--show-url", "print the local URL including the secret token").action((o: { port: string; host: string; showUrl?: boolean }) => {
  try {
    const { cfg, json } = cfgFrom();
    const binDir = resolve(process.argv[1], "..");
    const mcpBin = existsSync(join(binDir, "doltap-mcp")) ? join(binDir, "doltap-mcp") : "doltap-mcp";
    const tokenFile = ensureToken(cfg);
    const r = installHttpService(cfg, mcpBin, Number(o.port), o.host);
    const token = readFileSync(tokenFile, "utf8").trim();
    const url = `http://${o.host}:${o.port}/${token}/mcp`;
    out(json, { ...r, url: o.showUrl ? url : maskToken(url), tokenFile }, () => {
      console.log(`${r.platform}: ${r.detail}`);
      console.log(`local MCP URL: ${o.showUrl ? url : `${maskToken(url)}  (token: doltap serve token, or --show-url)`}`);
    });
  } catch (e) { fail(e); }
});
serve.command("uninstall").action(() => { try { const r = uninstallHttpService(); out(!!program.opts<GlobalOpts>().json, r, () => console.log(`${r.platform}: ${r.detail}`)); } catch (e) { fail(e); } });
serve.command("status").action(() => { try { const r = httpServiceStatus(); out(!!program.opts<GlobalOpts>().json, r, () => console.log(`${r.platform}: ${r.detail}`)); } catch (e) { fail(e); } });
serve.command("token").description("print the secret path token (rotate with --rotate, then re-run serve install)").option("--rotate").option("--quiet", "do not print the token (use with --rotate in scripts and agent sessions)").action((o: { rotate?: boolean; quiet?: boolean }) => {
  try {
    const { cfg } = cfgFrom();
    const p = ensureToken(cfg, !!o.rotate);
    if (o.quiet) { if (o.rotate) console.error(`token rotated: ${p}`); return; }
    process.stdout.write(readFileSync(p, "utf8"));
  } catch (e) { fail(e); }
});

// Named HTTP client tokens (.doltap/http-clients.json, read by doltap-mcp --http on each request).
interface HttpClientRec { token: string; readOnly: boolean; created: string }
function clientsFile(cfg: WikiConfig): string { return join(cfg.stateDir, "http-clients.json"); }
function loadClientRecs(cfg: WikiConfig): Record<string, HttpClientRec> {
  const p = clientsFile(cfg);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, HttpClientRec>) : {};
}
function saveClientRecs(cfg: WikiConfig, recs: Record<string, HttpClientRec>): void {
  const p = clientsFile(cfg);
  writeFileSync(p, JSON.stringify(recs, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
}
const client = serve.command("client").description("named tokens for remote clients: commits carry the name, --read-only tokens cannot write");
client.command("add <name>").description("create a token for a client and print it (pipe it to the clipboard; it is not shown again)").option("--read-only").action((name: string, o: { readOnly?: boolean }) => {
  try {
    const { cfg } = cfgFrom();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error("client name must be kebab-case");
    const recs = loadClientRecs(cfg);
    if (recs[name]) throw new Error(`client ${name} exists; remove it first to issue a new token`);
    const token = randomBytes(32).toString("hex");
    recs[name] = { token, readOnly: !!o.readOnly, created: new Date().toISOString().slice(0, 10) };
    saveClientRecs(cfg, recs);
    console.error(`client ${name} added (${o.readOnly ? "read-only" : "full access"}); the token follows on stdout`);
    process.stdout.write(token + "\n");
  } catch (e) { fail(e); }
});
client.command("list").action(() => {
  try {
    const { cfg, json } = cfgFrom();
    const recs = loadClientRecs(cfg);
    const rows = Object.entries(recs).map(([name, r]) => ({ name, readOnly: r.readOnly, created: r.created }));
    out(json, rows, () => { if (!rows.length) console.log("(no named clients; only the default token)"); for (const r of rows) console.log(`${r.name.padEnd(20)} ${r.readOnly ? "read-only" : "full     "} ${r.created}`); });
  } catch (e) { fail(e); }
});
client.command("remove <name>").action((name: string) => {
  try {
    const { cfg } = cfgFrom();
    const recs = loadClientRecs(cfg);
    if (!recs[name]) throw new Error(`no client named ${name}`);
    delete recs[name];
    saveClientRecs(cfg, recs);
    console.log(`removed client ${name}; its token stops working on the next request`);
  } catch (e) { fail(e); }
});

// ---------------------------------------------------------------- integrations (agent clients)
const INTEGRATIONS_DIR = fileURLToPath(new URL("../integrations/", import.meta.url));

/** Command that starts the stdio MCP server: the `doltap-mcp` shim next to this binary, or node + the JS entry on Windows. */
function stdioMcpCommand(): string[] {
  const binDir = resolve(process.argv[1], "..");
  if (process.platform !== "win32") return [existsSync(join(binDir, "doltap-mcp")) ? join(binDir, "doltap-mcp") : "doltap-mcp"];
  try { return ["node", createRequire(import.meta.url).resolve("@bluekds/doltap-mcp/dist/main.js")]; } catch { return ["doltap-mcp"]; }
}

function claudeCli(args: string[], allowFail = false): string | null {
  try { return execFileSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { if (allowFail) return null; throw e; }
}

const integrations = program.command("integrations").description("install the skill, global instruction and MCP registration for an agent client");
integrations
  .command("install <client>")
  .description("supported clients: claude (Claude Code, user scope: every project on this machine)")
  .option("--remote [url]", "register the always-on HTTPS endpoint instead of the local stdio server; omit the value to read it from $DOLTAP_REMOTE_URL (keeps the token out of shell history)")
  .option("--dry-run", "print what would change without writing anything")
  .action((client: string, o: { remote?: string | true; dryRun?: boolean }) => {
    try {
      if (client !== "claude") throw new Error(`unsupported client: ${client} (supported: claude)`);
      if (o.remote === true) {
        o.remote = process.env.DOLTAP_REMOTE_URL;
        if (!o.remote) throw new Error("--remote given without a URL and $DOLTAP_REMOTE_URL is not set");
      }
      const json = !!program.opts<GlobalOpts>().json;
      const src = join(INTEGRATIONS_DIR, "claude-code");
      const skillDir = join(homedir(), ".claude", "skills", "doltap");
      const claudeMd = join(homedir(), ".claude", "CLAUDE.md");
      const actions: string[] = [];
      const root = o.remote ? null : cfgFrom().cfg.root;
      actions.push(root ? `wiki root: ${root} (nearest wiki above the current directory, $DOLTAP_ROOT, or ~/.doltap; pass --root to override)` : `remote endpoint (no local clone)`);

      actions.push(`write ${join(skillDir, "SKILL.md")}`);
      if (!o.dryRun) {
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), readFileSync(join(src, "skills", "doltap", "SKILL.md")));
      }

      const snippet = readFileSync(join(src, "CLAUDE.md.snippet"), "utf8");
      const existing = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
      if (existing.includes("## Doltap")) actions.push(`keep ${claudeMd} (already has a Doltap section)`);
      else {
        actions.push(`${existing ? "append Doltap section to" : "create"} ${claudeMd}`);
        if (!o.dryRun) {
          mkdirSync(join(homedir(), ".claude"), { recursive: true });
          writeFileSync(claudeMd, existing ? `${existing.trimEnd()}\n\n${snippet.replace(/^# Global instructions\n\n/, "")}` : snippet);
        }
      }

      const addArgs = o.remote
        ? ["mcp", "add", "-s", "user", "--transport", "http", "doltap", o.remote]
        : ["mcp", "add", "-s", "user", "doltap", "-e", `DOLTAP_ROOT=${root}`, "-e", "DOLTAP_AGENT=claude-code", "--", ...stdioMcpCommand()];
      // Never echo the token: the shown command carries the masked URL (the real one is in $DOLTAP_REMOTE_URL or the argument).
      const shown = maskToken(`claude ${addArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
      let registered = false;
      if (o.dryRun) actions.push("run: claude mcp remove -s user doltap (replaces an existing registration, if any)", `run: ${shown}`);
      else if (claudeCli(["--version"], true) === null) actions.push(`claude CLI not found on PATH; run manually: ${shown}`);
      else {
        claudeCli(["mcp", "remove", "-s", "user", "doltap"], true);
        claudeCli(addArgs);
        registered = true;
        actions.push(`registered MCP server doltap (${o.remote ? "http" : "stdio"}, user scope)`);
      }
      out(json, { client, dryRun: !!o.dryRun, registered, actions }, () => {
        for (const a of actions) console.log(a.startsWith("wiki root:") || a.startsWith("remote endpoint") ? a : `${o.dryRun ? "would " : ""}${a}`);
        if (registered) console.log("done: new Claude Code sessions will see the doltap server and skill");
        else if (!o.dryRun) console.log("skill and instruction installed; register the MCP server with the command above");
      });
    } catch (e) { fail(e); }
  });
/** Checks on the Claude Code integration: installed skill copy, CLAUDE.md section, MCP registration. */
function integrationChecks(): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const packaged = join(INTEGRATIONS_DIR, "claude-code", "skills", "doltap", "SKILL.md");
  const installed = join(homedir(), ".claude", "skills", "doltap", "SKILL.md");
  const digest = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);
  if (!existsSync(installed)) checks.push({ name: "skill", status: "warn", detail: `no skill at ${installed}`, fix: "doltap integrations install claude" });
  else if (digest(installed) !== digest(packaged)) checks.push({ name: "skill", status: "warn", detail: `installed skill differs from the one shipped with doltap ${PKG_VERSION}`, fix: "doltap integrations install claude" });
  else checks.push({ name: "skill", status: "ok", detail: `skill matches doltap ${PKG_VERSION}` });
  const claudeMd = join(homedir(), ".claude", "CLAUDE.md");
  if (existsSync(claudeMd) && readFileSync(claudeMd, "utf8").includes("## Doltap")) checks.push({ name: "instructions", status: "ok", detail: `${claudeMd} has a Doltap section` });
  else checks.push({ name: "instructions", status: "warn", detail: `${claudeMd} has no Doltap section`, fix: "doltap integrations install claude" });
  if (claudeCli(["--version"], true) === null) { checks.push({ name: "mcp-registration", status: "skip", detail: "claude CLI not on PATH" }); return checks; }
  const reg = claudeCli(["mcp", "get", "doltap"], true);
  if (reg === null) checks.push({ name: "mcp-registration", status: "warn", detail: "doltap is not registered with Claude Code", fix: "doltap integrations install claude" });
  else {
    const type = /Type:\s*(\w+)/i.exec(reg)?.[1] ?? "registered";
    checks.push({ name: "mcp-registration", status: "ok", detail: `doltap registered (${maskToken(type)})` });
  }
  return checks;
}

integrations.command("status").description("report whether the installed skill, instruction section and MCP registration match this version").action(() => {
  try {
    const json = !!program.opts<GlobalOpts>().json;
    const checks = integrationChecks();
    out(json, { checks }, () => printChecks(checks, false));
  } catch (e) { fail(e); }
});

integrations
  .command("uninstall <client>")
  .description("remove the skill and the MCP registration (the CLAUDE.md section is left for you to delete)")
  .action((client: string) => {
    try {
      if (client !== "claude") throw new Error(`unsupported client: ${client} (supported: claude)`);
      const skillDir = join(homedir(), ".claude", "skills", "doltap");
      rmSync(skillDir, { recursive: true, force: true });
      const removed = claudeCli(["mcp", "remove", "-s", "user", "doltap"], true) !== null;
      console.log(`removed ${skillDir}; MCP registration ${removed ? "removed" : "not found or claude CLI missing"}; edit ${join(homedir(), ".claude", "CLAUDE.md")} by hand`);
    } catch (e) { fail(e); }
  });

program.parseAsync(process.argv).catch(fail);
