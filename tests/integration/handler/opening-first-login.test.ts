import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { applyMigrations } from "@aistudy/database";
import { createAuthRuntime, sessionCookieHeader } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET as me } from "../../../apps/web/src/app/api/auth/me/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as status, POST as complete } from "../../../apps/web/src/app/api/opening/onboarding/route";
import { GET as guidance, PUT as saveGuidance } from "../../../apps/web/src/app/api/opening/guidance-settings/route";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("isolated test database required");
const runtime = createAuthRuntime({ databaseUrl, authSecret: "loop-first-login-test-secret-32chars", sessionCookieSecure: false,
  sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
let cookie = "";
function req(path: string, method = "GET", body?: unknown, authenticated = true) {
  return new Request(`http://localhost${path}`, { method, headers: { origin: "http://localhost",
    ...(authenticated ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(async () => { await applyMigrations(runtime.sql); setAuthRuntimeForTests(runtime); });
beforeEach(async () => {
  vi.stubEnv("OPENING_RELEASE", "1");
  const created = await runtime.identity.createUserWithWorkspace({ email: `provision-${randomUUID()}@example.com`, displayName: "provisioned", passwordHash: "unused-test-only" });
  const issued = await runtime.sessions.issue({ userId: created.user.id, workspaceId: created.workspace.id });
  cookie = sessionCookieHeader(runtime, issued.token, issued.expiresAt).split(";")[0]!;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { setAuthRuntimeForTests(null); await runtime.close(); });
it("detects first login even with registration closed", async () => {
  expect((await register(req("/api/auth/register", "POST", {}))).status).toBe(403);
  const response = await me(req("/api/auth/me"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).onboardingRequired).toBe(true);
  const done = await complete(req("/api/opening/onboarding", "POST", { action: "complete", clientKey: randomUUID(), subject: "积分学", scenario: "final", examDate: null, timeZone: "Asia/Shanghai", sourceIds: [] }));
  expect(done.status).toBe(200);
  expect((await (await me(req("/api/auth/me"))).json()).onboardingRequired).toBe(false);
});
it("requires authentication for first-run and guidance operations", async () => {
  expect((await status(req("/api/opening/onboarding", "GET", undefined, false))).status).toBe(401);
  expect((await complete(req("/api/opening/onboarding", "POST", { action: "skip", clientKey: randomUUID() }, false))).status).toBe(401);
  expect((await guidance(req("/api/opening/guidance-settings", "GET", undefined, false))).status).toBe(401);
});
it("allows no-AI material-first entry and persists guidance without claiming auto execution", async () => {
  expect((await complete(req("/api/opening/onboarding", "POST", { action: "skip", clientKey: randomUUID() }))).status).toBe(200);
  const response = await saveGuidance(req("/api/opening/guidance-settings", "PUT", { mode: "coach", protectedSlots: [], dailyMinutes: 45 }));
  expect(response.status).toBe(200);
  expect((await response.json()).automaticReorderingActive).toBe(false);
  expect((await (await guidance(req("/api/opening/guidance-settings"))).json()).settings.dailyMinutes).toBe(45);
});
it("rejects invented ownership, malformed dates and oversized first-run bodies", async () => {
  expect((await complete(req("/api/opening/onboarding", "POST", { action: "skip", clientKey: randomUUID(), ownerUserId: randomUUID() }))).status).toBe(400);
  expect((await complete(req("/api/opening/onboarding", "POST", { action: "complete", clientKey: randomUUID(), subject: "x", scenario: "final", examDate: "2026-02-30", timeZone: "Asia/Shanghai", sourceIds: [] }))).status).toBe(400);
  expect((await complete(req("/api/opening/onboarding", "POST", { action: "skip", clientKey: "x".repeat(9000) }))).status).toBe(413);
});
