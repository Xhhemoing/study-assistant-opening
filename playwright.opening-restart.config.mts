import { defineConfig } from "@playwright/test";
import { buildOpeningE2eEnvironment } from "./scripts/opening-e2e/environment.mjs";

const env = buildOpeningE2eEnvironment();
Object.assign(process.env, env);
export default defineConfig({
  testDir: "./tests/restart", testMatch: "*.spec.ts", fullyParallel: false, workers: 1,
  timeout: 240_000, expect: { timeout: 15_000 },
  outputDir: "test-results/opening-restart",
  reporter: [["list"], ["html", { outputFolder: "playwright-report/opening-restart", open: "never" }]],
  use: { baseURL: env.PUBLIC_BASE_URL, navigationTimeout: 60_000, trace: "retain-on-failure", screenshot: "only-on-failure" },
  // The isolated test owns its two exact child processes. Reusing webServer's
  // reset/build command between cycles would destroy the persistence evidence.
});
