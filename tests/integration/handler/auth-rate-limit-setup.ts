import { beforeEach } from "vitest";
import { resetTestAuthRateLimits } from "../../support/auth-rate-limit-state";

// Handler files are serial. Await a reset before each isolated test, just as
// their database fixtures do; limits remain active during every test/request.
beforeEach(async () => {
  await resetTestAuthRateLimits({
    databaseUrl: process.env.DATABASE_URL!,
    redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    authSecret: process.env.AUTH_SECRET!,
  });
});
