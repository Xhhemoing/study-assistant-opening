import "server-only";
import { loadEnv } from "@aistudy/config";
import {
  createAuthRuntime,
  type AuthRuntime,
} from "../features/auth/service";

let cached: AuthRuntime | null = null;
const developmentRuntime = globalThis as typeof globalThis & { aistudyAuthRuntime?: AuthRuntime };

export function getAuthRuntime(): AuthRuntime {
  if (cached) return cached;
  // Next development hot reloads replace this module without closing its pool.
  if (process.env.NODE_ENV === "development" && developmentRuntime.aistudyAuthRuntime) {
    cached = developmentRuntime.aistudyAuthRuntime;
    return cached;
  }
  const env = loadEnv(process.env);
  cached = createAuthRuntime({
    databaseUrl: env.databaseUrl,
    authSecret: env.authSecret,
    sessionCookieSecure: env.sessionCookieSecure,
    sessionTtlSeconds: env.sessionTtlSeconds,
    authCookieName: env.authCookieName,
  });
  if (process.env.NODE_ENV === "development") developmentRuntime.aistudyAuthRuntime = cached;
  return cached;
}

/** Test helper to inject a runtime without process-wide env coupling. */
export function setAuthRuntimeForTests(runtime: AuthRuntime | null): void {
  cached = runtime;
  if (process.env.NODE_ENV === "development") developmentRuntime.aistudyAuthRuntime = runtime ?? undefined;
}
