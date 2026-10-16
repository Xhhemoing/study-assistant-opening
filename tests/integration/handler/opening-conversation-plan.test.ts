import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_PLANNING_SETTINGS, type ConversationPlanInspection, type Scope } from "@aistudy/contracts";
import { applyMigrations, createOpeningPlanningSettingsRepository, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET, POST } from "../../../apps/web/src/app/api/opening/plans/from-candidate/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { insertCandidate, insertOwnedConversation, insertTurn } from "../opening-memory-candidate-fixture";
const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime>;
let owner: { cookie: string; scope: Scope }, other: { cookie: string; scope: Scope };
async function user() {
  const response = await register(new Request("http://localhost/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${randomUUID()}@example.com`, password: "password123", displayName: "conversation plan" }) }));
  expect(response.status).toBe(201);
  const body = await response.json() as { user: { id: string; workspaceId: string } };
  return { cookie: `aistudy_session=${response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1]}`,
    scope: { workspaceId: body.user.workspaceId, ownerUserId: body.user.id } };
}
async function pending(scope = owner.scope) {
  const conversationId = await insertOwnedConversation(sql, scope), sourceTurnId = await insertTurn(sql, scope, conversationId);
  return insertCandidate(sql, scope, { conversationId, sourceTurnId, payload: { kind: "task", title: "对话练习", minutes: null, dueText: null } });
}
function req(path: string, method = "GET", body?: unknown, cookie = owner.cookie) {
  return new Request(`http://localhost${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({ databaseUrl, authSecret: "conversation-plan-handler-secret-32chars", sessionCookieSecure: false,
    sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime); owner = await user(); other = await user();
  await createOpeningPlanningSettingsRepository(sql).set(owner.scope, { ...DEFAULT_OPENING_PLANNING_SETTINGS, timeZone: "UTC" });
});
beforeEach(() => vi.stubEnv("OPENING_ADAPTIVE_PLANNING", "1"));
afterAll(async () => { vi.unstubAllEnvs(); setAuthRuntimeForTests(null); await runtime?.close(); await sql.end({ timeout: 5 }); });
it("requires authentication and respects the server feature switch", async () => {
  expect((await GET(req("/api/opening/plans/from-candidate", "GET", undefined, ""))).status).toBe(401);
  vi.stubEnv("OPENING_ADAPTIVE_PLANNING", "0");
  expect((await GET(req(`/api/opening/plans/from-candidate?candidateId=${randomUUID()}`))).status).toBe(404);
});
it("returns owned choices and clarification without writing a draft or a task", async () => {
  const id = await pending();
  const inspectionResponse = await GET(req(`/api/opening/plans/from-candidate?candidateId=${id}`));
  expect(inspectionResponse.status).toBe(200); expect(inspectionResponse.headers.get("cache-control")).toBe("no-store");
  const inspection = await inspectionResponse.json() as ConversationPlanInspection;
  expect(inspection).toMatchObject({ candidate: { id, title: "对话练习", minutes: null }, missing: ["course", "minutes"], timeZone: "UTC" });
  const response = await POST(req("/api/opening/plans/from-candidate", "POST", { candidateId: id, expectedVersion: 0,
    date: inspection.date, expectedAcceptedVersion: inspection.acceptedVersion, clientKey: `clarify:${id}` }));
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ kind: "clarification", missing: ["course", "minutes"] });
  expect(await sql`SELECT id FROM opening_tasks WHERE candidate_id=${id}`).toHaveLength(0);
  expect(await sql`SELECT id FROM opening_plan_drafts WHERE propose_client_key=${`clarify:${id}`}`).toHaveLength(0);
});
it("rejects foreign candidates and forged model-owned fields at the HTTP boundary", async () => {
  const id = await pending(other.scope);
  expect((await GET(req(`/api/opening/plans/from-candidate?candidateId=${id}`))).status).toBe(409);
  const own = await pending();
  const inspection = await (await GET(req(`/api/opening/plans/from-candidate?candidateId=${own}`))).json() as ConversationPlanInspection;
  const response = await POST(req("/api/opening/plans/from-candidate", "POST", { candidateId: own, expectedVersion: 0,
    date: inspection.date, expectedAcceptedVersion: inspection.acceptedVersion, clientKey: `forged:${own}`, title: "forged", courseId: null, minutes: 20 }));
  expect(response.status).toBe(400);
  expect(await sql`SELECT id FROM opening_tasks WHERE candidate_id=${own}`).toHaveLength(0);
});
