/**
 * Suppress Node's ExperimentalWarning for node:sqlite. Must run before `node:sqlite` is first imported,
 * so entry points import this module through a bootstrap that dynamic-imports the real code afterwards.
 */
const original = process.emitWarning.bind(process);
(process as { emitWarning: typeof process.emitWarning }).emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" && /SQLite/i.test(msg)) return;
  (original as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
export {};
