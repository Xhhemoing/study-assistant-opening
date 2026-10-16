import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { POST } from "../../../apps/web/src/app/api/opening/plans/replan/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime>, cookie: string;
beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({ databaseUrl, authSecret: "local-replan-handler-secret-32chars", sessionCookieSecure: false,
    sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
  const response = await register(new Request("http://localhost/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${randomUUID()}@example.com`, password: "password123", displayName: "replan" }) }));
  expect(response.status).toBe(201);
  cookie = `aistudy_session=${response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1]}`;
});
beforeEach(() => vi.stubEnv("OPENING_ADAPTIVE_PLANNING", "1"));
afterAll(async () => { vi.unstubAllEnvs(); setAuthRuntimeForTests(null); await runtime?.close(); await sql.end({ timeout: 5 }); });
const request = (body: unknown, authenticated = true) => new Request("http://localhost/api/opening/plans/replan", {
  method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { cookie } : {}) }, body: JSON.stringify(body),
});
it("requires authentication and closes the feature when disabled", async () => {
  const input = { date: "2026-10-16", expectedAcceptedVersion: 0, clientKey: "replan-handler" };
  expect((await POST(request(input, false))).status).toBe(401);
  vi.stubEnv("OPENING_ADAPTIVE_PLANNING", "0");
  expect((await POST(request(input))).status).toBe(404);
});
it("rejects impossible dates and client-provided preservation exemptions before any draft is written", async () => {
  const input = { date: "2026-02-30", expectedAcceptedVersion: 0, clientKey: "replan-forged" };
  expect((await POST(request(input))).status).toBe(400);
  const forged = await POST(request({ ...input, date: "2026-10-16", fixedBlocks: [], taskIds: [randomUUID()] }));
  expect(forged.status).toBe(400);
  expect(await sql`SELECT id FROM opening_plan_drafts WHERE propose_client_key='replan-forged'`).toHaveLength(0);
});
