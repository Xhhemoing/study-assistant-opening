import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as summary } from "../../../apps/web/src/app/api/opening/plans/coach/route";
import { POST as accept } from "../../../apps/web/src/app/api/opening/plans/coach/accept/route";
import { POST as undo } from "../../../apps/web/src/app/api/opening/plans/coach/undo/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime>, cookie: string, workspaceId: string;
const oldFlag = process.env.OPENING_ADAPTIVE_PLANNING;
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function request(path: string, body?: unknown, authenticated = true) {
  return new Request(`http://localhost/api/opening/plans/coach${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { ...(authenticated ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({ databaseUrl, authSecret: "opening-coach-plan-handler-secret-32chars!", sessionCookieSecure: false,
    sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
  const response = await register(new Request("http://localhost/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `coach-${randomUUID()}@example.com`, password: "password123", displayName: "Coach fixture" }) }));
  expect(response.status).toBe(201);
  workspaceId = (await response.json() as { user: { workspaceId: string } }).user.workspaceId;
  cookie = `aistudy_session=${response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1]}`;
  process.env.OPENING_ADAPTIVE_PLANNING = "1";
});
afterAll(async () => {
  if (oldFlag === undefined) delete process.env.OPENING_ADAPTIVE_PLANNING;
  else process.env.OPENING_ADAPTIVE_PLANNING = oldFlag;
  setAuthRuntimeForTests(null); await runtime?.close(); await sql.end({ timeout: 5 });
});

it("authenticates all coach routes", async () => {
  expect((await summary(request("?date=2026-10-21", undefined, false))).status).toBe(401);
  expect((await accept(request("/accept", { draftId: id, expectedDraftVersion: 0, clientKey: "coach:handler-test" }, false))).status).toBe(401);
  expect((await undo(request("/undo", { date: "2026-10-21", acceptanceClientKey: "coach:handler-test", expectedAcceptedVersion: 1, clientKey: "undo:handler-test" }, false))).status).toBe(401);
});
it("validates permissions intent and calendar dates before executing a transaction", async () => {
  const input = { draftId: id, expectedDraftVersion: 0, clientKey: "coach:handler-test" };
  expect((await accept(request("/accept", { ...input, budgetMinutes: 600 }))).status).toBe(400);
  expect((await undo(request("/undo", { date: "2026-02-30", acceptanceClientKey: "coach:handler-test", expectedAcceptedVersion: 1, clientKey: "undo:handler-test" }))).status).toBe(400);
  expect((await summary(request("?date=2026-02-30"))).status).toBe(400);
  expect((await accept(request("/accept", input))).status).toBe(404);
});
it("keeps GET summary read-only and routes unavailable when the feature is closed", async () => {
  const response = await summary(request("?date=2026-10-21"));
  expect(response.status).toBe(200); expect(await response.json()).toBeNull();
  expect(await sql`SELECT id FROM opening_plan_drafts WHERE workspace_id=${workspaceId}`).toHaveLength(0);
  expect(await sql`SELECT client_key FROM opening_plan_acceptances WHERE workspace_id=${workspaceId}`).toHaveLength(0);
  process.env.OPENING_ADAPTIVE_PLANNING = "0";
  try {
    expect((await summary(request("?date=2026-10-21"))).status).toBe(404);
    expect((await accept(request("/accept", { draftId: id, expectedDraftVersion: 0, clientKey: "coach:handler-test" }))).status).toBe(404);
  } finally { process.env.OPENING_ADAPTIVE_PLANNING = "1"; }
});
