import { test as base } from "@playwright/test";
import { resetTestAuthRateLimits } from "../support/auth-rate-limit-state";

export { expect, type BrowserContext, type Page } from "@playwright/test";

// Both E2E configs run one worker against one isolated database. Reset shared
// authentication counters before every case, including direct registration and
// capability-account logins. The production limiter stays active in each case.
export const test = base.extend<{ authRateLimitIsolation: void }>({
  authRateLimitIsolation: [async ({ baseURL: _baseURL }, use) => {
    await resetTestAuthRateLimits({
      databaseUrl: process.env.E2E_DATABASE_URL ?? "postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_e2e",
      redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      authSecret: process.env.AUTH_SECRET ?? "e2e-test-auth-secret-at-least-32-characters-long",
    });
    await use();
  }, { auto: true }],
});
