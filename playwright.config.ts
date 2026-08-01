import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_e2e";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx tsx scripts/db-reset-e2e.ts && npm run build -w @aistudy/web && npm run start -w @aistudy/web",
    url: `${baseURL}/login`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: "production",
      HERMES_HEAVY_LOCK_HELD: "1",
      DATABASE_URL: e2eDatabaseUrl,
      E2E_DATABASE_URL: e2eDatabaseUrl,
      REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
      S3_REGION: process.env.S3_REGION ?? "us-east-1",
      S3_BUCKET: process.env.S3_BUCKET ?? "aistudy",
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
      S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE ?? "true",
      PUBLIC_BASE_URL: baseURL,
      AUTH_SECRET: process.env.AUTH_SECRET ?? "e2e-test-auth-secret-at-least-32-characters-long",
      SESSION_COOKIE_SECURE: "false",
      SESSION_TTL_SECONDS: process.env.SESSION_TTL_SECONDS ?? "3600",
      AUTH_COOKIE_NAME: process.env.AUTH_COOKIE_NAME ?? "aistudy_session",
    },
  },
});
