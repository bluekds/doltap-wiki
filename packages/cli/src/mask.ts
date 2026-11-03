/**
 * Hide the HTTP path token in anything printed: the connector URL (`/<token>/mcp`) and a bare path token
 * (`/<64 hex>`), in either case. Error messages from child processes carry whole command lines, so every
 * message goes through this before it reaches a terminal or a JSON error.
 */
export function maskToken(text: string): string {
  return text.replace(/\/[0-9a-f]{32,}\/mcp\b/gi, "/<token>/mcp").replace(/\/[0-9a-f]{64}(?![0-9a-z])/gi, "/<token>");
}
