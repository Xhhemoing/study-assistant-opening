import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ApiError } from "./service";
import { authRateLimitKeyPrefix } from "./rate-limit-keys";

export type AuthAction = "login" | "register";
type RedisEvaluator = {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

// One atomic admission decision for every dimension, using Redis time. Every
// accepted request counts, including successful authentication. No process-local
// counters and no account reset that could bypass the shared IP/global budget.
const SLIDING_WINDOW_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local retry = 0
for i, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[i * 2])
  local window = tonumber(ARGV[i * 2 + 1])
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
  if redis.call('ZCARD', key) >= limit then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    retry = math.max(retry, tonumber(oldest[2]) + window - now)
  end
end
if retry > 0 then return math.ceil(retry / 1000) end
for i, key in ipairs(KEYS) do
  local window = tonumber(ARGV[i * 2 + 1])
  redis.call('ZADD', key, now, ARGV[1])
  redis.call('PEXPIRE', key, window)
end
return 0
`;

/** Only trust a header explicitly set/overwritten by an isolated reverse proxy. */
export function trustedClientIp(request: Request, trustedHeader?: string): string | null {
  if (!trustedHeader) return null;
  const value = request.headers.get(trustedHeader)?.trim();
  // Forwarded lists are ambiguous; a configured proxy must supply one address.
  if (!value || !isIP(value)) return null;
  return value.toLowerCase();
}

export function createAuthRateLimiter(input: {
  redis: RedisEvaluator;
  secret: string;
  scope?: string;
  trustedIpHeader?: string;
}) {
  const fingerprint = (value: string) => createHmac("sha256", input.secret).update(value).digest("hex");
  const keyPrefix = authRateLimitKeyPrefix(input.secret, input.scope);
  return async (request: Request, body: unknown, action: AuthAction): Promise<void> => {
    const rawEmail = body && typeof body === "object" && "email" in body ? body.email : null;
    const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
    const ip = trustedClientIp(request, input.trustedIpHeader);
    // A global budget remains active even without a safely attributable IP. This
    // deliberately trades availability during attack for bounded password CPU.
    const buckets = [
      { key: `${keyPrefix}:${action}:global`, limit: action === "login" ? 100 : 20, window: 60_000 },
      { key: `${keyPrefix}:${action}:account:${fingerprint(email)}`, limit: action === "login" ? 10 : 5, window: 900_000 },
      ...(ip ? [{ key: `${keyPrefix}:${action}:ip:${fingerprint(ip)}`, limit: action === "login" ? 50 : 10, window: 900_000 }] : []),
    ];
    let retry: unknown;
    try {
      retry = await input.redis.eval(
        SLIDING_WINDOW_SCRIPT,
        buckets.length,
        ...buckets.map(({ key }) => key),
        randomUUID(),
        ...buckets.flatMap(({ limit, window }) => [limit, window]),
      );
    } catch {
      // Authentication must not silently lose its protection during Redis failure.
      throw new ApiError("SERVICE_UNAVAILABLE", "登录服务暂不可用，请稍后重试。", 503, 5);
    }
    if (typeof retry !== "number" || !Number.isInteger(retry) || retry < 0) {
      throw new ApiError("SERVICE_UNAVAILABLE", "登录服务暂不可用，请稍后重试。", 503, 5);
    }
    if (retry > 0) {
      throw new ApiError("RATE_LIMITED", "尝试次数过多，请稍后重试。", 429, retry);
    }
  };
}
