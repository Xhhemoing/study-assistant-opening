import { defineConfig } from "@playwright/test";

// User-run acceptance against an already running full stack. No database reset or service startup.
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) throw new Error("Set E2E_BASE_URL to the acceptance environment before running the Opening smoke suite.");
if (!/^[a-f0-9]{40}$/i.test(process.env.AISTUDY_COMMIT ?? "")) {
  throw new Error("Set AISTUDY_COMMIT to the full merged commit expected in the acceptance environment.");
}

export default defineConfig({
  testDir: "./tests/e2e", testMatch: "opening-smoke.spec.ts",
  fullyParallel: false, workers: 1, retries: 0, timeout: 300_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results/opening-smoke",
  reporter: [["list"], ["html", { outputFolder: "playwright-report/opening-smoke", open: "never" }]],
  use: { baseURL, viewport: { width: 1440, height: 1000 }, navigationTimeout: 60_000,
    trace: "retain-on-failure", screenshot: "only-on-failure" },
});
