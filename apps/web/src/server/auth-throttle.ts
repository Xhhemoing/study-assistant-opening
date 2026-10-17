import "server-only";
import { loadEnv } from "@aistudy/config";
import { Redis } from "ioredis";
import { ApiError } from "../features/auth/service";
import { createAuthRateLimiter, type AuthAction } from "../features/auth/rate-limit";

let cached: { redis: Redis; ready: Promise<void>; limit: ReturnType<typeof createAuthRateLimiter> } | undefined;

export async function enforceAuthRateLimit(request: Request, body: unknown, action: AuthAction): Promise<void> {
  if (!cached) {
    const env = loadEnv(process.env);
    const redis = new Redis(env.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      retryStrategy: () => null,
    });
    // Do not emit raw connection errors (which can contain credentials/URLs).
    redis.on("error", () => undefined);
    cached = {
      redis,
      ready: redis.connect(),
      limit: createAuthRateLimiter({ redis, secret: env.authSecret, scope: env.databaseUrl, trustedIpHeader: env.authTrustedIpHeader }),
    };
  }
  const current = cached;
  try {
    await current.ready;
    await current.limit(request, body, action);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status === 503) {
      if (cached === current) cached = undefined;
      current.redis.disconnect();
      throw new ApiError("SERVICE_UNAVAILABLE", "登录服务暂不可用，请稍后重试。", 503, 5);
    }
    throw error;
  }
}
