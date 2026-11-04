import { rmSync } from "node:fs";

/** Remove the throwaway DOLTAP_STATE_HOME that vitest.config.ts created for this run. */
export default function setup(): () => void {
  const home = process.env.DOLTAP_STATE_HOME;
  return () => {
    if (home && /doltap-test-state-/.test(home)) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}
