// Child-process helper for security.test.ts: one upsert in a separate process. Run with `node --import tsx`.
import { resolveConfig, upsertPage } from "../src/index.js";

const [root, id] = process.argv.slice(2);
const cfg = resolveConfig({ root, noSync: true, agent: "conc" });
const body = "## Prerequisites\n\nx\n\n## Steps\n\n1. y\n\n## Verification\n\nz\n\n## Pitfalls\n\n- w\n\n## Related\n\n- [[howto/_index]]\n";
const r = upsertPage(cfg, { id, title: `Page ${id}`, summary: `Concurrent page ${id}.`, tags: ["wiki"], body, force: true });
if (r.refused) {
  process.stderr.write(JSON.stringify(r.issues) + "\n");
  process.exit(2);
}
