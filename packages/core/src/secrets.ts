/** The secret filter: shared by pages (lint), attachments, tag descriptions and audit reports. */

/**
 * Known secret formats. This is a regex net for common token shapes, not a guarantee: the protocol still
 * says to record where a secret lives and how to load it, never the value. Names are reported to the writer.
 */
const SECRET_PATTERNS: [string, RegExp][] = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["openai-key", /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35,}\b/],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["stripe-key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}\b/],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["slack-webhook", /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/],
  ["tailscale-key", /\btskey-(?:auth|api|client|scim)-[A-Za-z0-9-]{20,}/],
  ["azure-account-key", /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  // Doltap's own remote endpoint: /<64 hex>/mcp, and the bare path token after a slash. The URL is the credential.
  ["connector-url", /\/[0-9a-f]{64}\/mcp\b/i],
  ["path-token", /\/[0-9a-f]{64}(?![0-9a-z])/i],
  ["url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@/i],
  ["telegram-bot-token", /(?<![0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/],
  // `password = "..."` style, quoted (8+ chars) or unquoted (10+ chars that mix letters and digits).
  // Values starting with $ ( < { [ ` are placeholders or shell/env expressions ("where it lives", not the secret).
  // The unquoted value is validated after the match (digit and letter present) instead of with lookaheads, which rescanned
  // the rest of the line for every `token=` and went quadratic on crafted input (audit S4).
  ["credential-assignment", /(?:password|passwd|secret|api[_-]?key|access[_-]?key|token)\s*[:=]\s*(?:['"][^'"\s]{8,}['"]|[^\s'"$<{[`(][^\s'"`]{9,})/i],
];

/** Extra acceptance test for a raw regex match, by pattern name. */
function secretMatchOk(name: string, text: string): boolean {
  if (name === "openai-key") return /\d/.test(text);
  if (name === "credential-assignment") {
    const value = text.replace(/^[^:=]*[:=]\s*/, "");
    if (/^['"]/.test(value)) return true;
    return /\d/.test(value) && /[A-Za-z]/.test(value);
  }
  return true;
}

/** A match that is documentation, not a credential: the AWS docs key, YOUR_TOKEN_HERE, xxxx fillers, <angle placeholders>, ellipses. */
const PLACEHOLDER_RE = /EXAMPLE|YOUR_|xxxx|<[^>]*>|\.\.\.|…/i;

/**
 * Does `raw` contain a credential of this shape? Every match is checked against the placeholder list, and a
 * key-shaped match without a single digit (`sk-learn-preprocessing-pipeline-guide`) is prose, not a key.
 */
/** Remove a line break (and continuation indentation) that sits between two token characters, so a wrapped credential reads as one. */
export function joinWrappedLines(raw: string): string {
  return raw.replace(/([A-Za-z0-9_-])\r?\n[ \t]*(?=[A-Za-z0-9_])/g, "$1");
}

export function secretMatches(name: string, re: RegExp, raw: string): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of raw.matchAll(g)) {
    const text = m[0];
    if (PLACEHOLDER_RE.test(text)) continue;
    if (!secretMatchOk(name, text)) continue;
    return true;
  }
  return false;
}

/** Names of the credential shapes found in `raw` ("<name>" or "<name>, split across lines"), empty when clean. */
export function findSecrets(raw: string): string[] {
  const out: string[] = [];
  const joined = joinWrappedLines(raw);
  for (const [name, re] of SECRET_PATTERNS) {
    if (secretMatches(name, re, raw)) out.push(name);
    else if (joined !== raw && secretMatches(name, re, joined)) out.push(`${name}, split across lines`);
  }
  return out;
}
