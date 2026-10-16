import { execFileSync } from "node:child_process";
import path from "node:path";

const projectRoot = path.resolve(__dirname, "../..");

/**
 * Reset the guarded *_e2e database in a separate tsx process, the same way the
 * webServer command does. Importing scripts/db-reset-e2e.ts into a spec breaks
 * Playwright's CommonJS loader because that script (and migrate.ts) use import.meta.
 */
export function resetE2eDatabase(): void {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is required to reset the e2e database");
  execFileSync(process.execPath, ["--import", "tsx", "scripts/db-reset-e2e.ts"], {
    cwd: projectRoot,
    env: { ...process.env, E2E_DATABASE_URL: url },
    stdio: "inherit",
  });
}
