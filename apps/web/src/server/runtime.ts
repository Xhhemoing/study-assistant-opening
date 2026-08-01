import { loadEnv } from "@aistudy/config";
import {
  createAuthRuntime,
  type AuthRuntime,
} from "../features/auth/service";

let cached: AuthRuntime | null = null;

export function getAuthRuntime(): AuthRuntime {
  if (cached) return cached;
  const env = loadEnv(process.env);
  cached = createAuthRuntime({
    databaseUrl: env.databaseUrl,
    authSecret: env.authSecret,
    sessionCookieSecure: env.sessionCookieSecure,
    sessionTtlSeconds: env.sessionTtlSeconds,
    authCookieName: env.authCookieName,
  });
  return cached;
}

/** Test helper to inject a runtime without process-wide env coupling. */
export function setAuthRuntimeForTests(runtime: AuthRuntime | null): void {
  cached = runtime;
}
