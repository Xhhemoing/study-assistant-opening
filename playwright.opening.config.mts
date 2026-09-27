import { defineConfig } from "@playwright/test";
import { buildOpeningE2eEnvironment } from "./scripts/opening-e2e/environment.mjs";

const env = buildOpeningE2eEnvironment();
Object.assign(process.env, env);
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "opening-*.spec.ts",
  fullyParallel: false, workers: 1, timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results/opening-isolated",
  reporter: [["list"], ["html", { outputFolder: "playwright-report/opening-isolated", open: "never" }]],
  use: { baseURL: env.PUBLIC_BASE_URL, navigationTimeout: 60_000, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "node scripts/opening-e2e/server.mjs", url: `${env.PUBLIC_BASE_URL}/login`,
    timeout: 600_000, reuseExistingServer: false,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  },
});
