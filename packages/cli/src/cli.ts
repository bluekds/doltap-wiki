import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATEGORIES,
  CONFIDENCE,
  get,
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
  related,
  resolveConfig,
  search,
  upsertPage,
  WikiDb,
  writeIndexMd,
  audit,
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
} from "@bluekds/doltap-core";

const program = new Command();
program
  .name("doltap")
  .description("Doltap: shared knowledge base for AI agents")
  .version("0.1.0")
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
  const o: ConfigOverrides = { root: g.root, agent: g.agent, session: g.session, noSync: !g.sync };
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
  .action((q: string[], o: { category?: string; tag?: string; confidence?: string; limit: string; includeDeprecated?: boolean }) => {
    try {
      const { cfg, json } = cfgFrom();
      const { hits, sync } = search(cfg, q.join(" "), { ...o, limit: Number(o.limit) });
      out(json, { hits, sync }, () => {
        if (!hits.length) console.log("no results");
        for (const h of hits) {
          console.log(`${h.id}  [${h.confidence}]  ${h.tags.join(",")}`);
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
      out(json, { id, meta: page.meta, section: o.section ?? null, text, links: page.links, backlinks, sections: page.sections.map((s) => s.heading), sync }, () => {
        if (o.meta || !o.section) {
          console.log(`# ${page.meta.title}`);
          console.log(`id: ${id} | confidence: ${page.meta.confidence} | tags: ${page.meta.tags.join(", ")} | updated: ${page.meta.updated}`);
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
      const pages = rows.filter((r) => !r.id.endsWith("/_index") && r.id !== "Home");
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
program.command("tags").description("list allowed tags").action(() => {
  try {
    const { cfg, json } = cfgFrom();
    const tags = loadTags(cfg);
    out(json, tags, () => { for (const t of tags) console.log(`${t.tag.padEnd(14)} ${t.group.padEnd(9)} ${t.description}`); });
  } catch (e) { fail(e); }
});

// ---------------------------------------------------------------- add
program
  .command("add <id>")
  .description("create a page (id = <category>/<slug>). Body from --file/--stdin or the template.")
  .requiredOption("--title <text>")
  .requiredOption("--summary <text>", "1-2 sentences, max 200 chars")
  .option("--tags <list>", "comma-separated, must exist in _meta/tags.yaml")
  .option("--confidence <level>", "draft|verified", "draft")
  .option("--sources <list>", "comma-separated URLs/ids")
  .option("-f, --file <path>", "markdown body file")
  .option("--stdin", "read body from stdin")
  .option("--force", "create even if similar pages exist")
  .action((id: string, o: { title: string; summary: string; tags?: string; confidence: string; sources?: string; file?: string; stdin?: boolean; force?: boolean }) => {
    try {
      const { cfg, json } = cfgFrom();
      const body = o.file || o.stdin ? readContent(o) : undefined;
      const r = upsertPage(cfg, {
        id, title: o.title, summary: o.summary, confidence: o.confidence, body, force: o.force,
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
  .action((id: string, o: { section: string; content?: string; file?: string; stdin?: boolean; append?: boolean; touch: boolean }) => {
    try {
      const { cfg, json } = cfgFrom();
      const r = patchSection(cfg, { id, section: o.section, content: readContent(o), mode: o.append ? "append" : "replace", touch: o.touch });
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
  .description("update frontmatter: --confidence, --add-source, --add-tag, --title, --summary")
  .option("--confidence <level>", CONFIDENCE.join("|"))
  .option("--add-source <s>", "repeatable", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--add-tag <t>", "repeatable", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--title <text>")
  .option("--summary <text>")
  .action((id: string, o: { confidence?: string; addSource: string[]; addTag: string[]; title?: string; summary?: string }) => {
    try {
      const { cfg, json } = cfgFrom();
      const r = patchMeta(cfg, { id, confidence: o.confidence, addSources: o.addSource, addTags: o.addTag, title: o.title, summary: o.summary });
      out(json, r, () => {
        if (r.refused) { console.log(`refused: ${r.refused}`); printIssues(r.issues); process.exitCode = 2; return; }
        console.log(`updated ${r.id} frontmatter`);
        printIssues(r.issues);
        for (const n of syncNotes(r.sync)) console.log(`note: ${n}`);
      });
    } catch (e) { fail(e); }
  });

// ---------------------------------------------------------------- related
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
program.command("sync").description("pull, push pending commits, reindex, report conflict files").action(() => {
  try {
    const { cfg, json } = cfgFrom();
    const report = syncAll(cfg);
    const db = new WikiDb(cfg);
    const r = db.reindex();
    const published = publishHostStats(cfg, db, report);
    db.close();
    writeIndexMd(cfg);
    const conflicts = listConflictFiles(cfg);
    out(json, { ...report, reindexed: r.indexed, removed: r.removed, total: r.total, statsPublished: published, conflictFiles: conflicts }, () => {
      console.log(`pulled: ${report.pulled} pushed: ${report.pushed} offline: ${report.offline} | pages: ${r.total} (reindexed ${r.indexed}, removed ${r.removed})${published ? " | stats published" : ""}`);
      for (const n of syncNotes(report)) console.log(`note: ${n}`);
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
    out(json, { ...r, pages: undefined, indexMd: p }, () => console.log(`indexed ${r.indexed}/${r.total} pages, removed ${r.removed}; wrote ${p}`));
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
        section("conflict files -> merge", r.conflictFiles.map((id) => ({ id })));
        section("most read", r.mostRead);
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
serve.command("install").option("--port <n>", "listen port", "8765").option("--host <h>", "bind address", "127.0.0.1").action((o: { port: string; host: string }) => {
  try {
    const { cfg, json } = cfgFrom();
    const binDir = resolve(process.argv[1], "..");
    const mcpBin = existsSync(join(binDir, "doltap-mcp")) ? join(binDir, "doltap-mcp") : "doltap-mcp";
    const r = installHttpService(cfg, mcpBin, Number(o.port), o.host);
    const token = readFileSync(join(cfg.stateDir, "http-token"), "utf8").trim();
    out(json, { ...r, url: `http://${o.host}:${o.port}/${token}/mcp` }, () => {
      console.log(`${r.platform}: ${r.detail}`);
      console.log(`local MCP URL: http://${o.host}:${o.port}/${token}/mcp`);
    });
  } catch (e) { fail(e); }
});
serve.command("uninstall").action(() => { try { const r = uninstallHttpService(); out(!!program.opts<GlobalOpts>().json, r, () => console.log(`${r.platform}: ${r.detail}`)); } catch (e) { fail(e); } });
serve.command("status").action(() => { try { const r = httpServiceStatus(); out(!!program.opts<GlobalOpts>().json, r, () => console.log(`${r.platform}: ${r.detail}`)); } catch (e) { fail(e); } });
serve.command("token").description("print the secret path token (rotate with --rotate; restart the service afterwards)").option("--rotate").action((o: { rotate?: boolean }) => {
  try {
    const { cfg } = cfgFrom();
    const p = join(cfg.stateDir, "http-token");
    if (o.rotate || !existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    process.stdout.write(readFileSync(p, "utf8"));
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
  .option("--remote <url>", "register the always-on HTTPS endpoint instead of the local stdio server")
  .option("--dry-run", "print what would change without writing anything")
  .action((client: string, o: { remote?: string; dryRun?: boolean }) => {
    try {
      if (client !== "claude") throw new Error(`unsupported client: ${client} (supported: claude)`);
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
      const shown = `claude ${addArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
      if (o.dryRun) actions.push("run: claude mcp remove -s user doltap (replaces an existing registration, if any)", `run: ${shown}`);
      else if (claudeCli(["--version"], true) === null) actions.push(`claude CLI not found on PATH; run manually: ${shown}`);
      else {
        claudeCli(["mcp", "remove", "-s", "user", "doltap"], true);
        claudeCli(addArgs);
        actions.push(`registered MCP server doltap (${o.remote ? "http" : "stdio"}, user scope)`);
      }
      out(json, { client, dryRun: !!o.dryRun, actions }, () => {
        for (const a of actions) console.log(`${o.dryRun ? "would " : ""}${a}`);
        if (!o.dryRun) console.log("done: new Claude Code sessions will see the doltap server and skill");
      });
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
