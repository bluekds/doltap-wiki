import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
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

const LABEL = "com.doltap.sync";
const TASK_NAME = "DoltapSync";

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function cronMarker(): string {
  return "# doltap-sync";
}

/**
 * On Windows the `wiki` entry is a .cmd shim that schtasks cannot launch reliably, so the task runs
 * `node <main.js>` directly. `wikiBin` is process.argv[1] (the JS entry) from the CLI.
 */
function windowsCommand(cfg: WikiConfig, wikiBin: string, logFile: string): string {
  return `cmd /c ""${process.execPath}" "${wikiBin}" --root "${cfg.root}" --agent scheduler sync >> "${logFile}" 2>&1"`;
}

export interface ScheduleResult {
  platform: string;
  installed: boolean;
  detail: string;
}

/** Install a periodic `doltap sync` (launchd on macOS, crontab elsewhere). */
export function installSchedule(cfg: WikiConfig, wikiBin: string, intervalMinutes = 10): ScheduleResult {
  const logDir = join(cfg.stateDir, "logs");
  mkdirSync(logDir, { recursive: true });
  if (platform() === "win32") {
    const tr = windowsCommand(cfg, wikiBin, join(logDir, "sync.log"));
    execFileSync("schtasks", ["/Create", "/F", "/SC", "MINUTE", "/MO", String(intervalMinutes), "/TN", TASK_NAME, "/TR", tr], { stdio: "ignore" });
    return { platform: "schtasks", installed: true, detail: `task ${TASK_NAME} every ${intervalMinutes} min; logs in ${logDir}` };
  }
  if (platform() === "darwin") {
    const plist = launchdPlist({
      label: LABEL,
      program: [stableNodePath(), wikiBin, "--root", cfg.root, "--agent", "scheduler", "sync"],
      startInterval: intervalMinutes * 60,
      stdout: join(logDir, "sync.log"),
      stderr: join(logDir, "sync.err"),
    });
    const p = plistPath();
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    if (existsSync(p)) { try { execFileSync("launchctl", ["unload", p], { stdio: "ignore" }); } catch { /* not loaded */ } }
    writeFileSync(p, plist);
    execFileSync("launchctl", ["load", p], { stdio: "ignore" });
    return { platform: "launchd", installed: true, detail: `${p} every ${intervalMinutes} min; logs in ${logDir}` };
  }
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  const line = `*/${intervalMinutes} * * * * ${q(stableNodePath())} ${q(wikiBin)} --root ${q(cfg.root)} --agent scheduler sync >> ${q(join(logDir, "sync.log"))} 2>&1 ${cronMarker()}`;
  let current = "";
  try { current = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { current = ""; }
  const kept = current.split("\n").filter((l) => l && !l.includes(cronMarker()));
  execFileSync("crontab", ["-"], { input: [...kept, line].join("\n") + "\n" });
  return { platform: "crontab", installed: true, detail: line };
}

export function uninstallSchedule(): ScheduleResult {
  if (platform() === "win32") {
    try { execFileSync("schtasks", ["/Delete", "/F", "/TN", TASK_NAME], { stdio: "ignore" }); } catch { return { platform: "schtasks", installed: false, detail: "not installed" }; }
    return { platform: "schtasks", installed: false, detail: `removed task ${TASK_NAME}` };
  }
  if (platform() === "darwin") {
    const p = plistPath();
    if (!existsSync(p)) return { platform: "launchd", installed: false, detail: "not installed" };
    try { execFileSync("launchctl", ["unload", p], { stdio: "ignore" }); } catch { /* already unloaded */ }
    rmSync(p);
    return { platform: "launchd", installed: false, detail: `removed ${p}` };
  }
  let current = "";
  try { current = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { current = ""; }
  const kept = current.split("\n").filter((l) => l && !l.includes(cronMarker()));
  execFileSync("crontab", ["-"], { input: kept.join("\n") + (kept.length ? "\n" : "") });
  return { platform: "crontab", installed: false, detail: "removed doltap line" };
}

export function scheduleStatus(): ScheduleResult {
  if (platform() === "win32") {
    try {
      const out = execFileSync("schtasks", ["/Query", "/TN", TASK_NAME, "/FO", "LIST"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const status = /Status:\s*(.+)/.exec(out)?.[1]?.trim() ?? "unknown";
      return { platform: "schtasks", installed: true, detail: `task ${TASK_NAME} (${status})` };
    } catch { return { platform: "schtasks", installed: false, detail: "not installed" }; }
  }
  if (platform() === "darwin") {
    const p = plistPath();
    if (!existsSync(p)) return { platform: "launchd", installed: false, detail: "not installed" };
    let loaded = false;
    try { loaded = execFileSync("launchctl", ["list"], { encoding: "utf8" }).includes(LABEL); } catch { /* ignore */ }
    return { platform: "launchd", installed: true, detail: `${p} (${loaded ? "loaded" : "NOT loaded"})` };
  }
  let current = "";
  try { current = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { current = ""; }
  const line = current.split("\n").find((l) => l.includes(cronMarker()));
  return { platform: "crontab", installed: !!line, detail: line ?? "not installed" };
}

// ------------------------------------------------------------------ always-on HTTP MCP service
const SERVICE_LABEL = "com.doltap.mcp";

function servicePlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

/** Keep `doltap-mcp --http` running (launchd KeepAlive). macOS only for now; other platforms get instructions. */
export function installHttpService(cfg: WikiConfig, mcpBin: string, port = 8765, host = "127.0.0.1"): ScheduleResult {
  const logDir = join(cfg.stateDir, "logs");
  mkdirSync(logDir, { recursive: true });
  if (platform() !== "darwin") {
    return { platform: platform(), installed: false, detail: `run as a service: ${mcpBin} --http --port ${port} --host ${host} (DOLTAP_ROOT=${cfg.root})` };
  }
  const plist = launchdPlist({
    label: SERVICE_LABEL,
    program: [stableNodePath(), mcpBin, "--http", "--port", String(port), "--host", host],
    env: { DOLTAP_ROOT: cfg.root, DOLTAP_AGENT: "mcp-http" },
    keepAlive: true,
    stdout: join(logDir, "mcp-http.log"),
    stderr: join(logDir, "mcp-http.err"),
  });
  const p = servicePlistPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  if (existsSync(p)) { try { execFileSync("launchctl", ["unload", p], { stdio: "ignore" }); } catch { /* not loaded */ } }
  writeFileSync(p, plist);
  execFileSync("launchctl", ["load", p], { stdio: "ignore" });
  return { platform: "launchd", installed: true, detail: `${p} -> http://${host}:${port}; logs in ${logDir}` };
}

export function uninstallHttpService(): ScheduleResult {
  if (platform() !== "darwin") return { platform: platform(), installed: false, detail: "no service manager integration on this platform" };
  const p = servicePlistPath();
  if (!existsSync(p)) return { platform: "launchd", installed: false, detail: "not installed" };
  try { execFileSync("launchctl", ["unload", p], { stdio: "ignore" }); } catch { /* already unloaded */ }
  rmSync(p);
  return { platform: "launchd", installed: false, detail: `removed ${p}` };
}

export function httpServiceStatus(): ScheduleResult {
  if (platform() !== "darwin") return { platform: platform(), installed: false, detail: "no service manager integration on this platform" };
  const p = servicePlistPath();
  if (!existsSync(p)) return { platform: "launchd", installed: false, detail: "not installed" };
  let line = "";
  try { line = execFileSync("launchctl", ["list"], { encoding: "utf8" }).split("\n").find((l) => l.includes(SERVICE_LABEL)) ?? ""; } catch { /* ignore */ }
  const pid = line.split("\t")[0];
  return { platform: "launchd", installed: true, detail: pid && pid !== "-" ? `running (pid ${pid})` : "loaded but not running" };
}
