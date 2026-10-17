import { Redis } from "ioredis";
import { authRateLimitKeyPrefix } from "../../apps/web/src/features/auth/rate-limit-keys";

/** Reset only the authentication fixture namespace, never Redis/queue contents. */
export async function resetTestAuthRateLimits(input: { databaseUrl: string; redisUrl: string; authSecret: string }): Promise<void> {
  const database = new URL(input.databaseUrl);
  const name = decodeURIComponent(database.pathname.slice(1));
  if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname)
    || !(name === "aistudy_opening_test" || /^aistudy_prb_scratch_\d{8,14}$/.test(name) || name.endsWith("_e2e"))) {
    throw new Error("Refusing to reset auth rate limits outside an isolated loopback test database");
  }
  const prefix = authRateLimitKeyPrefix(input.authSecret, input.databaseUrl);
  const redis = new Redis(input.redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 2_000, commandTimeout: 2_000, retryStrategy: () => null });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");
  } finally { redis.disconnect(); }
}
