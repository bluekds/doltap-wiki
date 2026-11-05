import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import type { WikiConfig } from "./config.js";

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * The Node binary to record in a service definition. `process.execPath` is often a versioned Homebrew
 * Cellar path that disappears on the next `brew upgrade`, after which launchd keeps respawning a dead path.
 * Prefer a stable alias (`/opt/homebrew/opt/node@24/bin/node`, `/opt/homebrew/bin/node`, …) that resolves to
 * the same binary; fall back to execPath.
 */
export function stableNodePath(execPath = process.execPath, candidates?: string[]): string {
  const major = process.versions.node.split(".")[0];
  const defaults = [
    `/opt/homebrew/opt/node@${major}/bin/node`,
    "/opt/homebrew/opt/node/bin/node",
    "/opt/homebrew/bin/node",
    `/usr/local/opt/node@${major}/bin/node`,
    "/usr/local/opt/node/bin/node",
    "/usr/local/bin/node",
  ];
  let real: string;
  try { real = realpathSync(execPath); } catch { return execPath; }
  for (const c of candidates ?? defaults) {
    try { if (realpathSync(c) === real) return c; } catch { /* candidate missing */ }
  }
  return execPath;
}

export interface LaunchdSpec {
  label: string;
  program: string[];
  env?: Record<string, string>;
  stdout: string;
  stderr: string;
  keepAlive?: boolean;
  startInterval?: number;
}

/** Render a LaunchAgent plist with every value XML-escaped. KeepAlive jobs get a ThrottleInterval so a crashing binary is not respawned in a tight loop. */
export function launchdPlist(spec: LaunchdSpec): string {
  const env = { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", ...(spec.env ?? {}) };
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xmlEscape(spec.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...spec.program.map((a) => `    <string>${xmlEscape(a)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(env).map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`),
    "  </dict>",
  ];
  if (spec.startInterval) lines.push(`  <key>StartInterval</key><integer>${spec.startInterval}</integer>`);
  if (spec.keepAlive) lines.push("  <key>KeepAlive</key><true/>", "  <key>ThrottleInterval</key><integer>10</integer>");
  lines.push(
    "  <key>RunAtLoad</key><true/>",
    `  <key>StandardOutPath</key><string>${xmlEscape(spec.stdout)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(spec.stderr)}</string>`,
    "</dict>",
    "</plist>",
    "",
  );
  return lines.join("\n");
}

export interface ServiceNames {
  /** launchd label of the periodic sync job. */
  sync: string;
  /** launchd label of the HTTP MCP service. */
  mcp: string;
  /** Windows Task Scheduler task name of the periodic sync. */
  task: string;
  /** Trailing comment that marks this wiki's crontab line. */
  cronMarker: string;
}

export interface ServiceLabels extends ServiceNames {
  /** Names earlier versions used for this wiki (the 0.10/0.11.0 dotted id when the root is `~/.doltap`, the pre-0.10 global names); install removes them, status and uninstall still see them. */
  legacy: ServiceNames[];
}

function namesFor(id: string | null): ServiceNames {
  const sfx = id ? `.${id}` : "";
  return { sync: `com.doltap.sync${sfx}`, mcp: `com.doltap.mcp${sfx}`, task: id ? `DoltapSync-${id}` : "DoltapSync", cronMarker: id ? `# doltap-sync ${id}` : "# doltap-sync" };
}

/** Service names carry the wiki id since 0.10, so two wikis on one machine keep separate jobs. */
export function serviceLabels(cfg: Pick<WikiConfig, "wikiId">): ServiceLabels {
  const legacy: ServiceNames[] = [];
  // Before 0.11.1 a root named `.doltap` produced the id `.doltap-<hash>`.
  if (/^doltap-[0-9a-f]{8}$/.test(cfg.wikiId)) legacy.push(namesFor(`.${cfg.wikiId}`));
  legacy.push(namesFor(null));
  return { ...namesFor(cfg.wikiId), legacy };
}

const plistFile = (label: string): string => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

/** Unload and delete a launchd plist if present; returns whether there was one. */
function dropPlist(p: string): boolean {
  if (!existsSync(p)) return false;
  try { execFileSync("launchctl", ["unload", p], { stdio: "ignore" }); } catch { /* not loaded */ }
  rmSync(p, { force: true });
  return true;
}

/** The crontab line carrying `marker` as its trailing comment. A legacy line has the bare marker and nothing after it. */
function cronLine(current: string, marker: string): string | undefined {
  return current.split("\n").find((l) => l.trimEnd().endsWith(marker));
}

function readCrontab(): string {
  try { return execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
}

/**
 * On Windows the task runs a one-line wrapper script in the state dir instead of a `cmd /c "..."` action:
 * the Task Scheduler read the nested quotes of the long inline command differently from a shell and the
 * task exited 1 before even opening the log. The `wiki` entry is a .cmd shim that schtasks cannot launch
 * reliably either, so the script runs `node <cli.js>` directly. `wikiBin` is the JS entry (process.argv[1]).
 */
export function windowsSyncScript(cfg: WikiConfig, wikiBin: string, nodeExe = process.execPath): { script: string; taskRun: string; content: string } {
  const script = join(cfg.stateDir, "sync.cmd");
  const log = join(cfg.stateDir, "logs", "sync.log");
  const content = `@echo off\r\n"${nodeExe}" "${wikiBin}" --root "${cfg.root}" --agent scheduler sync >> "${log}" 2>&1\r\n`;
  return { script, taskRun: `"${script}"`, content };
}

/** `schtasks /Query /FO CSV /NH` prints TaskName, Next Run Time, Status without the localised labels of the LIST form. */
export function parseSchtasksCsv(out: string): { next: string; status: string } | null {
  const line = out.split(/\r?\n/).find((l) => l.startsWith('"'));
  if (!line) return null;
  const cells = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (cells.length < 3) return null;
  return { next: cells[1], status: cells[2] };
}

export interface ScheduleResult {
  platform: string;
  installed: boolean;
  detail: string;
  /** Sync interval recorded in the service definition (launchd StartInterval or crontab step), when known. */
  intervalMinutes?: number;
  /** HTTP service bind address and port recorded in the plist, when known. */
  host?: string;
  port?: number;
  /** The job or service exists only under the pre-0.10 global name; the install command must be re-run. */
  legacy?: boolean;
  /** Process id of a running service, when the service manager reports one. */
  pid?: number;
}

/** Read `--flag value` pairs and StartInterval back out of a plist written by launchdPlist. */
function plistArgs(path: string): { args: string[]; startInterval?: number } {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return { args: [] }; }
  const unescape = (v: string) => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const arr = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  const args = [...arr.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unescape(m[1]));
  const si = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1];
  return { args, startInterval: si ? Number(si) : undefined };
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The crontab time fields for "every N minutes": a minute step below an hour, an hourly step for whole hours (cron reads a 90-minute step as "every 90th minute of the hour", which is hourly). */
export function cronStep(intervalMinutes: number): string {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) throw new Error(`--every must be a positive number of minutes (got ${intervalMinutes})`);
  if (intervalMinutes < 60) return `*/${intervalMinutes} * * * *`;
  if (intervalMinutes % 60 !== 0 || intervalMinutes > 1440) throw new Error(`--every above 59 minutes must be a multiple of 60 up to 1440 (got ${intervalMinutes}): cron cannot express it`);
  return `0 */${intervalMinutes / 60} * * *`;
}

/** Install a periodic `doltap sync` (launchd on macOS, Task Scheduler on Windows, crontab elsewhere). A job left by doltap 0.x under the global name is removed. */
export function installSchedule(cfg: WikiConfig, wikiBin: string, intervalMinutes = 10): ScheduleResult {
  const logDir = join(cfg.stateDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const labels = serviceLabels(cfg);
  if (platform() === "win32") {
    for (const l of labels.legacy) { try { execFileSync("schtasks", ["/Delete", "/F", "/TN", l.task], { stdio: "ignore" }); } catch { /* none */ } }
    const w = windowsSyncScript(cfg, wikiBin);
    writeFileSync(w.script, w.content);
    execFileSync("schtasks", ["/Create", "/F", "/SC", "MINUTE", "/MO", String(intervalMinutes), "/TN", labels.task, "/TR", w.taskRun], { stdio: "ignore" });
    return { platform: "schtasks", installed: true, detail: `task ${labels.task} every ${intervalMinutes} min (runs ${w.script}); logs in ${logDir}` };
  }
  if (platform() === "darwin") {
    const plist = launchdPlist({
      label: labels.sync,
      program: [stableNodePath(), wikiBin, "--root", cfg.root, "--agent", "scheduler", "sync"],
      startInterval: intervalMinutes * 60,
      stdout: join(logDir, "sync.log"),
      stderr: join(logDir, "sync.err"),
    });
    const p = plistFile(labels.sync);
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    for (const l of labels.legacy) dropPlist(plistFile(l.sync));
    dropPlist(p);
    writeFileSync(p, plist);
    execFileSync("launchctl", ["load", p], { stdio: "ignore" });
    return { platform: "launchd", installed: true, detail: `${p} every ${intervalMinutes} min; logs in ${logDir}` };
  }
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  const line = `${cronStep(intervalMinutes)} ${q(stableNodePath())} ${q(wikiBin)} --root ${q(cfg.root)} --agent scheduler sync >> ${q(join(logDir, "sync.log"))} 2>&1 ${labels.cronMarker}`;
  const current = readCrontab();
  const mine = [labels, ...labels.legacy].map((n) => cronLine(current, n.cronMarker));
  const kept = current.split("\n").filter((l) => l && !mine.includes(l));
  execFileSync("crontab", ["-"], { input: [...kept, line].join("\n") + "\n" });
  return { platform: "crontab", installed: true, detail: line };
}

export function uninstallSchedule(cfg: WikiConfig): ScheduleResult {
  const labels = serviceLabels(cfg);
  if (platform() === "win32") {
    let removed = false;
    for (const t of [labels.task, ...labels.legacy.map((l) => l.task)]) { try { execFileSync("schtasks", ["/Delete", "/F", "/TN", t], { stdio: "ignore" }); removed = true; } catch { /* not there */ } }
    rmSync(windowsSyncScript(cfg, "").script, { force: true });
    return { platform: "schtasks", installed: false, detail: removed ? `removed task ${labels.task}` : "not installed" };
  }
  if (platform() === "darwin") {
    const removed = [plistFile(labels.sync), ...labels.legacy.map((l) => plistFile(l.sync))].filter(dropPlist);
    return { platform: "launchd", installed: false, detail: removed.length ? `removed ${removed.join(", ")}` : "not installed" };
  }
  const current = readCrontab();
  const mine = [labels, ...labels.legacy].map((n) => cronLine(current, n.cronMarker));
  const kept = current.split("\n").filter((l) => l && !mine.includes(l));
  execFileSync("crontab", ["-"], { input: kept.join("\n") + (kept.length ? "\n" : "") });
  return { platform: "crontab", installed: false, detail: "removed doltap line" };
}

const LEGACY_HINT = "installed under the pre-0.10 global name; re-run the install command so it carries this wiki's id and the new log path";

export function scheduleStatus(cfg: WikiConfig): ScheduleResult {
  const labels = serviceLabels(cfg);
  if (platform() === "win32") {
    for (const t of [labels.task, ...labels.legacy.map((l) => l.task)]) {
      try {
        const out = execFileSync("schtasks", ["/Query", "/TN", t, "/FO", "CSV", "/NH"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const parsed = parseSchtasksCsv(out);
        const legacy = t !== labels.task;
        return { platform: "schtasks", installed: true, legacy, detail: `task ${t} (${parsed?.status ?? "unknown"}${parsed?.next ? `, next ${parsed.next}` : ""})${legacy ? `; ${LEGACY_HINT}` : ""}` };
      } catch { /* try the next name */ }
    }
    return { platform: "schtasks", installed: false, detail: "not installed" };
  }
  if (platform() === "darwin") {
    for (const label of [labels.sync, ...labels.legacy.map((l) => l.sync)]) {
      const p = plistFile(label);
      if (!existsSync(p)) continue;
      let loaded = false;
      try { loaded = execFileSync("launchctl", ["list"], { encoding: "utf8" }).includes(label); } catch { /* ignore */ }
      const si = plistArgs(p).startInterval;
      const legacy = label !== labels.sync;
      return { platform: "launchd", installed: true, legacy, detail: `${p} (${loaded ? "loaded" : "NOT loaded"})${legacy ? `; ${LEGACY_HINT}` : ""}`, intervalMinutes: si ? Math.round(si / 60) : undefined };
    }
    return { platform: "launchd", installed: false, detail: "not installed" };
  }
  const current = readCrontab();
  const mine = cronLine(current, labels.cronMarker);
  const line = mine ?? labels.legacy.map((n) => cronLine(current, n.cronMarker)).find(Boolean);
  const step = line ? /^\*\/(\d+)\s/.exec(line)?.[1] : undefined;
  return { platform: "crontab", installed: !!line, legacy: !!line && !mine, detail: line ? `${line}${mine ? "" : `; ${LEGACY_HINT}`}` : "not installed", intervalMinutes: step ? Number(step) : undefined };
}

// ------------------------------------------------------------------ always-on HTTP MCP service

/** Keep `doltap-mcp --http` running (launchd KeepAlive). macOS only for now; other platforms get instructions. A service left by doltap 0.x under the global name is removed. */
export function installHttpService(cfg: WikiConfig, mcpBin: string, port = 8765, host = "127.0.0.1"): ScheduleResult {
  const logDir = join(cfg.stateDir, "logs");
  mkdirSync(logDir, { recursive: true });
  if (platform() !== "darwin") {
    return { platform: platform(), installed: false, detail: `run as a service: ${mcpBin} --http --port ${port} --host ${host} (DOLTAP_ROOT=${cfg.root})` };
  }
  const labels = serviceLabels(cfg);
  const plist = launchdPlist({
    label: labels.mcp,
    program: [stableNodePath(), mcpBin, "--http", "--port", String(port), "--host", host],
    env: { DOLTAP_ROOT: cfg.root, DOLTAP_AGENT: "mcp-http" },
    keepAlive: true,
    stdout: join(logDir, "mcp-http.log"),
    stderr: join(logDir, "mcp-http.err"),
  });
  const p = plistFile(labels.mcp);
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  for (const l of labels.legacy) dropPlist(plistFile(l.mcp));
  dropPlist(p);
  writeFileSync(p, plist);
  execFileSync("launchctl", ["load", p], { stdio: "ignore" });
  return { platform: "launchd", installed: true, detail: `${p} -> http://${host}:${port}; logs in ${logDir}` };
}

export function uninstallHttpService(cfg: WikiConfig): ScheduleResult {
  if (platform() !== "darwin") return { platform: platform(), installed: false, detail: "no service manager integration on this platform" };
  const labels = serviceLabels(cfg);
  const removed = [plistFile(labels.mcp), ...labels.legacy.map((l) => plistFile(l.mcp))].filter(dropPlist);
  return { platform: "launchd", installed: false, detail: removed.length ? `removed ${removed.join(", ")}` : "not installed" };
}

export function httpServiceStatus(cfg: WikiConfig): ScheduleResult {
  if (platform() !== "darwin") return { platform: platform(), installed: false, detail: "no service manager integration on this platform" };
  const labels = serviceLabels(cfg);
  for (const label of [labels.mcp, ...labels.legacy.map((l) => l.mcp)]) {
    const p = plistFile(label);
    if (!existsSync(p)) continue;
    let line = "";
    try { line = execFileSync("launchctl", ["list"], { encoding: "utf8" }).split("\n").find((l) => l.endsWith(`\t${label}`)) ?? ""; } catch { /* ignore */ }
    const pid = line.split("\t")[0];
    const args = plistArgs(p).args;
    const port = Number(argValue(args, "--port") ?? 8765);
    const host = argValue(args, "--host") ?? "127.0.0.1";
    const running = !!pid && pid !== "-";
    const legacy = label !== labels.mcp;
    const detail = running ? `running (pid ${pid}) on ${host}:${port}` : `loaded but not running (${line ? "" : "not loaded; "}${host}:${port})`;
    return { platform: "launchd", installed: true, legacy, detail: legacy ? `${detail}; ${LEGACY_HINT}` : detail, host, port, pid: running ? Number(pid) : undefined };
  }
  return { platform: "launchd", installed: false, detail: "not installed" };
}
