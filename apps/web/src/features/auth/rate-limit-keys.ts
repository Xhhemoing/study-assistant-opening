import { createHmac } from "node:crypto";

/** Separate deployments sharing Redis without putting credentials in keys. */
export function authRateLimitKeyPrefix(secret: string, scope = "default"): string {
  const namespace = createHmac("sha256", secret).update(`auth-namespace:${scope}`).digest("hex").slice(0, 24);
  return `aistudy:{auth:${namespace}}`;
}
