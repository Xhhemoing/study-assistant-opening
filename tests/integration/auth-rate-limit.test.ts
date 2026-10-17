import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthRateLimiter } from "../../apps/web/src/features/auth/rate-limit";
import { authRateLimitKeyPrefix } from "../../apps/web/src/features/auth/rate-limit-keys";
import { resetTestAuthRateLimits } from "../support/auth-rate-limit-state";

describe("authentication admission against real Redis", () => {
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const first = new Redis(redisUrl, { maxRetriesPerRequest: 0, connectTimeout: 2_000, commandTimeout: 2_000 });
  const second = new Redis(redisUrl, { maxRetriesPerRequest: 0, connectTimeout: 2_000, commandTimeout: 2_000 });
  const scope = `auth-integration-${randomUUID()}`;
  const secret = "isolated-auth-integration-secret";
  const prefix = authRateLimitKeyPrefix(secret, scope);
  const limiter = (redis: Redis, trustedIpHeader?: string) => createAuthRateLimiter({ redis, secret, scope, trustedIpHeader });
  const request = (ip?: string) => new Request("http://localhost/api/auth/login", { headers: ip ? { "x-real-ip": ip } : {} });
  const clear = async () => {
    const keys = await first.keys(`${prefix}:*`);
    if (keys.length) await first.del(...keys);
  };
  beforeEach(clear);
  afterAll(async () => { await clear(); first.disconnect(); second.disconnect(); });

  it("admits exactly 10 concurrent attempts for one account across independent clients", async () => {
    const a = limiter(first);
    const b = limiter(second);
    const attempts = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b)(request(), { email: i % 2 ? "Owner@Example.com" : "owner@example.com" }, "login")));
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(10);
    for (const attempt of attempts) if (attempt.status === "rejected") {
      expect(attempt.reason).toMatchObject({ code: "RATE_LIMITED", status: 429 });
      expect(attempt.reason.retryAfterSeconds).toBeGreaterThan(0);
      expect(attempt.reason.retryAfterSeconds).toBeLessThanOrEqual(900);
    }
  });

  it("limits one trusted IP even while email addresses change", async () => {
    const limit = limiter(first, "x-real-ip");
    const attempts = await Promise.allSettled(Array.from({ length: 70 }, (_, i) => limit(request("192.0.2.10"), { email: `${i}@example.com` }, "login")));
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(50);
  });

  it("keeps a global cap when no client address can be safely attributed", async () => {
    const limit = limiter(first);
    const attempts = await Promise.allSettled(Array.from({ length: 120 }, (_, i) => limit(request(), { email: `${i}@example.com` }, "login")));
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(100);
  });

  it("uses separate registration budgets and expires old sliding-window entries", async () => {
    const limit = limiter(first);
    for (let i = 0; i < 5; i++) await limit(request(), { email: "new@example.com" }, "register");
    await expect(limit(request(), { email: "new@example.com" }, "register")).rejects.toMatchObject({ status: 429 });
    await expect(limit(request(), { email: "new@example.com" }, "login")).resolves.toBeUndefined();
    const keys = await first.keys(`${prefix}:register:*`);
    for (const key of keys) {
      const members = await first.zrange(key, 0, -1);
      for (const member of members) await first.zadd(key, Date.now() - 901_000, member);
    }
    await expect(limit(request(), { email: "new@example.com" }, "register")).resolves.toBeUndefined();
    expect(await first.pttl(keys.find((key) => key.includes(":account:"))!)).toBeGreaterThan(890_000);
  });

  it("isolates test resets from another deployment and queue keys", async () => {
    const databaseUrl = `postgres://auth-fixture@127.0.0.1/aistudy_opening_test?application_name=${randomUUID()}`;
    const fixturePrefix = authRateLimitKeyPrefix(secret, databaseUrl);
    const queueKey = `auth-regression-unrelated-queue:${randomUUID()}`;
    const fixtureLimit = createAuthRateLimiter({ redis: first, secret, scope: databaseUrl });
    try {
      for (let i = 0; i < 10; i++) await fixtureLimit(request(), { email: "fixture@example.com" }, "login");
      await limiter(first)(request(), { email: "other-deployment@example.com" }, "login");
      await first.set(queueKey, "preserved");
      await resetTestAuthRateLimits({ databaseUrl, redisUrl, authSecret: secret });
      await expect(fixtureLimit(request(), { email: "fixture@example.com" }, "login")).resolves.toBeUndefined();
      expect(await first.get(queueKey)).toBe("preserved");
      expect(await first.keys(`${prefix}:*`)).not.toHaveLength(0);
      await expect(resetTestAuthRateLimits({ databaseUrl: "postgres://localhost/production", redisUrl, authSecret: secret })).rejects.toThrow(/isolated loopback test database/);
    } finally {
      const fixtureKeys = await first.keys(`${fixturePrefix}:*`);
      await first.del(queueKey, ...fixtureKeys);
    }
  });
});
