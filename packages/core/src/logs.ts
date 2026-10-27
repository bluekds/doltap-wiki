import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import type { WikiConfig } from "./config.js";

export interface LogFile {
  name: string;
  path: string;
  bytes: number;
}

export interface RotateOptions {
  /** Rotate a log once it exceeds this many bytes. */
  maxBytes?: number;
  /** How many rotated generations to keep (`name.1`, `name.2`, …). */
  keep?: number;
}

export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;

export function logDir(cfg: WikiConfig): string {
  return join(cfg.stateDir, "logs");
}

/** Current (unrotated) log files in .doltap/logs with their sizes. */
export function listLogs(cfg: WikiConfig): LogFile[] {
  const dir = logDir(cfg);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /\.(log|err)$/.test(n))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return { name, path, bytes: statSync(path).size };
    });
}

/**
 * Copy-then-truncate rotation: launchd keeps the HTTP service's log open for the life of the process, so a
 * rename would leave it writing to the rotated file. Copying the content aside and truncating in place works
 * for both the long-running service and the short scheduler runs (both open the file with O_APPEND).
 */
export function rotateLogs(cfg: WikiConfig, o: RotateOptions = {}): string[] {
  const maxBytes = o.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const keep = Math.max(1, o.keep ?? 3);
  const rotated: string[] = [];
  for (const log of listLogs(cfg)) {
    if (log.bytes <= maxBytes) continue;
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? log.path : `${log.path}.${i - 1}`;
      const to = `${log.path}.${i}`;
      if (i === keep && existsSync(to)) rmSync(to, { force: true });
      if (i === 1) copyFileSync(from, to);
      else if (existsSync(from)) renameSync(from, to);
    }
    truncateSync(log.path, 0);
    rotated.push(log.name);
  }
  return rotated;
}
