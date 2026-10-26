import { existsSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface WikiConfig {
  /** Repository root (contains wiki/ and .git). */
  root: string;
  /** Directory holding pages: <root>/wiki */
  wikiDir: string;
  /** Per-machine state dir: <root>/.doltap (gitignored) */
  stateDir: string;
  dbPath: string;
  hostname: string;
  /** Client identity recorded in commit messages. */
  agent: string;
  session?: string;
  /** Skip git pull/push entirely (tests, offline). */
  noSync: boolean;
  /** Minutes before an automatic pull is attempted on read. */
  autoPullMinutes: number;
}

export const CATEGORIES = ["howto", "patterns", "reference", "decisions", "projects"] as const;

/** Structural pages: `Home` and the category hubs (`<category>/_index`). Project hubs (`projects/<name>/_index`) are content. */
export function isCategoryHub(id: string): boolean {
  return id === "Home" || /^[^/]+\/_index$/.test(id);
}

/** A project overview page: `projects/<name>/_index`, or the legacy flat `projects/<name>`. Topic pages below a project are free-form. */
export function isProjectOverview(id: string): boolean {
  return /^projects\/[^/]+(\/_index)?$/.test(id);
}

export type Category = (typeof CATEGORIES)[number];
export const CONFIDENCE = ["draft", "verified", "deprecated"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

const MARKER = join("wiki", "_meta", "PROTOCOL.md");

function isRoot(dir: string): boolean {
  return existsSync(join(dir, MARKER));
}

/** Walk up from `from` until a directory containing wiki/_meta/PROTOCOL.md is found. */
export function findRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (isRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface ConfigOverrides {
  root?: string;
  agent?: string;
  session?: string;
  noSync?: boolean;
  autoPullMinutes?: number;
}

/**
 * Resolution order for the root: explicit override > $DOLTAP_ROOT > walk up from cwd > ~/.doltap.
 */
export function resolveConfig(o: ConfigOverrides = {}): WikiConfig {
  const env = process.env;
  const candidates = [o.root, env.DOLTAP_ROOT, findRoot(process.cwd()), join(homedir(), ".doltap")].filter(
    (c): c is string => !!c,
  );
  const root = candidates.map((c) => resolve(c)).find(isRoot);
  if (!root) {
    throw new Error(
      `Doltap root not found. Tried: ${candidates.join(", ")}. Run \`doltap init\` or set DOLTAP_ROOT.`,
    );
  }
  const stateDir = join(root, ".doltap");
  mkdirSync(stateDir, { recursive: true });
  return {
    root,
    wikiDir: join(root, "wiki"),
    stateDir,
    dbPath: join(stateDir, "index.sqlite"),
    hostname: hostname().split(".")[0],
    agent: o.agent ?? env.DOLTAP_AGENT ?? "cli",
    session: o.session ?? env.DOLTAP_SESSION,
    noSync: o.noSync ?? env.DOLTAP_NO_SYNC === "1",
    autoPullMinutes: o.autoPullMinutes ?? Number(env.DOLTAP_AUTO_PULL_MINUTES ?? 10),
  };
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
