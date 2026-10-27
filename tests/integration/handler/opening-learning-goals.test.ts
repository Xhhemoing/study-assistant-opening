import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST, GET } from "../../../apps/web/src/app/api/opening/learning-goals/route";
import { PATCH } from "../../../apps/web/src/app/api/opening/learning-goals/[id]/route";
import { POST as select } from "../../../apps/web/src/app/api/opening/learning-goals/select/route";
let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET!,
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await f?.close(); });
function req(path: string, method: string, body?: unknown, cookie = f.cookie) {
  return new Request(`http://localhost/api/opening/learning-goals${path}`, { method, headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
it("uses authenticated goal writes and recovers an unknown edit without another revision", async () => {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'HTTP course',${courseId})`;
  const input = { courseIds: [courseId], title: "全课目标", kind: "custom", targetDate: "2027-02-01", examDate: null,
    weeklyMinutes: 90, priority: 1, learningMode: "auto", successCriteria: "独立验证全课要求", clientKey: randomUUID() };
  const response = await POST(req("", "POST", input));
  expect(response.status).toBe(200); const goal = await response.json();
  expect(goal).toMatchObject({ workspaceId: f.scope.workspaceId, revision: 1, examDate: null });
  const context = { params: Promise.resolve({ id: goal.id }) };
  const patch = { expectedRevision: 1, weeklyMinutes: 100 };
  expect((await PATCH(req(`/${goal.id}`, "PATCH", patch), context)).status).toBe(200);
  const replay = await PATCH(req(`/${goal.id}`, "PATCH", patch), context);
  expect(replay.status).toBe(200); expect((await replay.json()).revision).toBe(2);
  expect((await PATCH(req(`/${goal.id}`, "PATCH", { ...patch, weeklyMinutes: 110 }), context)).status).toBe(409);
  const selected = await select(req("/select", "POST", { courseId, goalId: goal.id, expectedRevision: 2, expectedSelectedGoalId: goal.id }));
  expect(selected.status).toBe(200);
  const list = await GET(req(`?courseId=${courseId}`, "GET"));
  expect(list.headers.get("cache-control")).toBe("no-store");
  expect((await list.json()).goals[0]).toMatchObject({ revision: 2, weeklyMinutes: 100 });
  expect((await POST(req("", "POST", { ...input, workspaceId: f.otherScope.workspaceId }))).status).toBe(400);
  expect((await GET(req("", "GET", undefined, ""))).status).toBe(401);
});
