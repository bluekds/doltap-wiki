import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface WikiConfig {
  /** Repository root (contains wiki/ and .git). */
  root: string;
  /** Directory holding pages: <root>/wiki */
  wikiDir: string;
  /** Per-machine state (index, lock, sync state, token, client list, logs): $DOLTAP_STATE_HOME/<wikiId>, outside the git tree. */
  stateDir: string;
  dbPath: string;
  /** `<root name>-<8 hex of the root's real path>`: names the state dir and the per-wiki service labels. */
  wikiId: string;
  /** Where 0.x kept the state (`<root>/.doltap`). Migrated away once; anything that reappears there is reported, never read. */
  legacyStateDir: string;
  hostname: string;
  /** Client identity recorded in commit messages. */
  agent: string;
  session?: string;
  /** Skip git pull/push entirely (tests, offline). */
  noSync: boolean;
  /** Minutes before an automatic pull is attempted on read; also how long a write skips the remote after it was found unreachable. */
  autoPullMinutes: number;
  /** Upper bound for one pull or push, ms. A write never waits longer than this for the remote. */
  remoteTimeoutMs: number;
  /** Commit only and leave the push to a background flusher (the HTTP server). The write returns as soon as the commit is made. */
  deferPush: boolean;
}

export const CATEGORIES = ["howto", "patterns", "reference", "decisions", "projects"] as const;

/** Structural pages: `Home` and the category hubs (`<category>/_index`). Project hubs (`projects/<name>/_index`) are content. */
/** Agent names doltap itself writes into commit trailers and session ids; a named HTTP client may not take one. */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set(["mcp-http", "mcp", "scheduler", "doltap-init", "cli"]);

/** Client names land in commit trailers (`[agent:<name>]`): kebab-case, never a name doltap uses itself. */
export function assertClientName(name: string): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error("client name must be kebab-case (letters, digits, single dashes)");
  if (RESERVED_AGENT_NAMES.has(name)) throw new Error(`client name ${name} is reserved for doltap itself; pick another`);
}

export function isCategoryHub(id: string): boolean {
  return id === "Home" || /^[^/]+\/_index$/.test(id);
}

/** A project overview page: `projects/<name>/_index`, or the legacy flat `projects/<name>`. Topic pages below a project are free-form. */
export function isProjectOverview(id: string): boolean {
  return /^projects\/[^/]+(\/_index)?$/.test(id);
}

export type Category = (typeof CATEGORIES)[number];
export const CONFIDENCE = ["draft", "verified", "deprecated"] as const;

/**
 * Categories whose pages do not go wrong with age: a decision record or a project overview is deprecated only
 * when superseded, never for being old. They are excluded from age-based audit lists and from the recency boost.
 */
export const DURABLE_CATEGORIES: readonly string[] = ["decisions", "projects"];

/**
 * How long a volatile page without an explicit `review_by` counts as reviewed, measured from `verified_on`
 * (or `updated`). Pages about external services and tool versions drift; the author can tighten this per page.
 */
export const REVIEW_DEFAULT_DAYS: Record<string, number> = { reference: 180, howto: 365 };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Add `days` to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Turn a user-supplied `review_by` ("60" days from `from`, a YYYY-MM-DD date, or "none"/"" to clear) into a date or null.
 */
export function reviewByFrom(value: string | undefined | null, from: string): string | null {
  const v = (value ?? "").trim();
  if (!v || v === "none" || v === "never") return null;
  if (DATE_ONLY.test(v)) return v;
  if (/^\d+$/.test(v) && Number(v) > 0) return addDays(from, Number(v));
  throw new Error(`review_by must be a number of days, a YYYY-MM-DD date, or none; got ${JSON.stringify(v)}`);
}
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
  remoteTimeoutMs?: number;
  deferPush?: boolean;
}

/** The directory under which every wiki's state lives: $DOLTAP_STATE_HOME, else the platform's state home plus `doltap`. */
export function stateHome(): string {
  const env = process.env;
  if (env.DOLTAP_STATE_HOME) return resolve(env.DOLTAP_STATE_HOME);
  if (platform() === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "doltap", "state");
  return join(env.XDG_STATE_HOME ? resolve(env.XDG_STATE_HOME) : join(homedir(), ".local", "state"), "doltap");
}

/**
 * `<root name>-<8 hex>` from the root's real path. The path, not the remote, is the identity: two clones of
 * one wiki on a machine have separate indexes and locks. Moving the root therefore starts fresh state
 * (index rebuilt, a new token unless DOLTAP_STATE_DIR pins the directory).
 */
export function wikiId(root: string): string {
  let real = resolve(root);
  try { real = realpathSync.native(real); } catch { /* not created yet */ }
  return `${basename(real).replace(/[^A-Za-z0-9._-]/g, "_")}-${createHash("sha256").update(real).digest("hex").slice(0, 8)}`;
}

/** The state directory for `root`: $DOLTAP_STATE_DIR when set (this wiki only), else `stateHome()/wikiId(root)`. */
export function stateDirFor(root: string): string {
  return process.env.DOLTAP_STATE_DIR ? resolve(process.env.DOLTAP_STATE_DIR) : join(stateHome(), wikiId(root));
}

/** Names of entries under a 0.x `.doltap/` that are not worth carrying over: a lock is only valid for a running writer, upgrade-tmp is scratch. */
const LEGACY_SKIP = new Set(["write.lock", "upgrade-tmp"]);

/**
 * One-time move of a 0.x `<root>/.doltap/` into the private state dir. Runs only while the new dir does not
 * exist yet, so a `.doltap/` that reappears later (a collaborator pushed one) is never merged over live state.
 * Files git tracks and symlinks stay where they are: the first is someone else's content, the second would
 * move whatever it points at. Returns the entries moved.
 */
export function migrateLegacyState(root: string, legacy: string, stateDir: string): string[] {
  if (existsSync(stateDir)) return [];
  let st;
  try { st = lstatSync(legacy); } catch { return []; }
  if (!st.isDirectory()) return [];
  let tracked = new Set<string>();
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", ".doltap"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    tracked = new Set(out.split("\0").filter(Boolean).map((f) => f.replace(/^\.doltap\//, "").split("/")[0]));
  } catch { /* not a repo */ }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  for (const name of readdirSync(legacy)) {
    const from = join(legacy, name);
    if (LEGACY_SKIP.has(name) || tracked.has(name)) continue;
    const entry = lstatSync(from);
    if (entry.isSymbolicLink()) continue;
    const to = join(stateDir, name);
    try { renameSync(from, to); } catch {
      cpSync(from, to, { recursive: true });
      rmSync(from, { recursive: true, force: true });
    }
    moved.push(name);
  }
  for (const name of LEGACY_SKIP) rmSync(join(legacy, name), { recursive: true, force: true });
  if (!readdirSync(legacy).length) rmSync(legacy, { recursive: true, force: true });
  return moved;
}

/**
 * Resolution order for the root: explicit override > $DOLTAP_ROOT > walk up from cwd > ~/.doltap.
 * An explicit root (`--root`, `DOLTAP_ROOT`) that is not a wiki is an error, never a fallback: a typo or a
 * throwaway directory must not silently land writes, tokens or test data in the real wiki.
 */
export function resolveConfig(o: ConfigOverrides = {}): WikiConfig {
  const env = process.env;
  const explicit = o.root ?? env.DOLTAP_ROOT;
  if (explicit && !isRoot(resolve(explicit))) {
    throw new Error(`Doltap root ${resolve(explicit)} is not a wiki (no wiki/ directory). Run \`doltap init\` there or fix --root / DOLTAP_ROOT.`);
  }
  const candidates = [explicit, findRoot(process.cwd()), join(homedir(), ".doltap")].filter((c): c is string => !!c);
  const root = candidates.map((c) => resolve(c)).find(isRoot);
  if (!root) {
    throw new Error(
      `Doltap root not found. Tried: ${candidates.join(", ")}. Run \`doltap init\` or set DOLTAP_ROOT.`,
    );
  }
  const legacyStateDir = join(root, ".doltap");
  const stateDir = stateDirFor(root);
  migrateLegacyState(root, legacyStateDir, stateDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") { try { chmodSync(stateDir, 0o700); } catch { /* not ours to change */ } }
  return {
    root,
    wikiDir: join(root, "wiki"),
    stateDir,
    dbPath: join(stateDir, "index.sqlite"),
    wikiId: wikiId(root),
    legacyStateDir,
    hostname: hostname().split(".")[0],
    agent: o.agent ?? env.DOLTAP_AGENT ?? "cli",
    // Claude Code exports CLAUDE_CODE_SESSION_ID to the commands it runs; it is the natural "same session" for the CLI.
    session: o.session ?? env.DOLTAP_SESSION ?? env.CLAUDE_CODE_SESSION_ID,
    noSync: o.noSync ?? env.DOLTAP_NO_SYNC === "1",
    autoPullMinutes: o.autoPullMinutes ?? Number(env.DOLTAP_AUTO_PULL_MINUTES ?? 10),
    remoteTimeoutMs: o.remoteTimeoutMs ?? Number(env.DOLTAP_REMOTE_TIMEOUT_MS ?? 15000),
    deferPush: o.deferPush ?? env.DOLTAP_DEFER_PUSH === "1",
  };
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
