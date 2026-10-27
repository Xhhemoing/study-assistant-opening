import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET, PUT } from "../../../apps/web/src/app/api/opening/courses/[id]/learning-route/route";
import { GET as task } from "../../../apps/web/src/app/api/opening/courses/[id]/learning-route/task/route";
import { POST as retest } from "../../../apps/web/src/app/api/opening/courses/[id]/learning-route/retest/route";

let f: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET!,
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime); vi.stubEnv("OPENING_TEACHING_LOOP", "1");
});
afterAll(async () => { setAuthRuntimeForTests(null); vi.unstubAllEnvs(); await runtime?.close(); await f?.close(); });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (courseId: string, method: string, suffix = "", body?: unknown, cookie = f.cookie) =>
  new Request(`http://localhost/api/opening/courses/${courseId}/learning-route${suffix}`, { method,
    headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

it("authenticates course manifests and keeps a missing requirement visible through the actual handler", async () => {
  const id = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${f.scope.workspaceId},'Handler course',${id})`;
  const requirement = { id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: "course:chapter-1",
    title: "第一章", position: 0, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [], origin: "confirmed",
    verification: { kind: "unavailable", status: "missing", exerciseKeys: [], rubric: null, missingReasons: ["待补充材料"] } };
  const body = { expectedRevisions: [], requirements: [requirement], confirmScope: true };
  expect((await PUT(request(id, "PUT", "", body, ""), context(id))).status).toBe(401);
  const saved = await PUT(request(id, "PUT", "", body), context(id));
  expect(saved.status).toBe(200); expect(saved.headers.get("Cache-Control")).toBe("no-store");
  expect((await saved.json()).summary).toMatchObject({ total: 1, mandatory: 1, verified: 0, blocked: 1 });
  const read = await GET(request(id, "GET"), context(id));
  expect(read.status).toBe(200);
  expect((await read.json()).requirements[0].requirement).toMatchObject({ id: requirement.id, revision: 1 });
  expect((await PUT(request(id, "PUT", "", { ...body, workspaceId: f.otherScope.workspaceId }), context(id))).status).toBe(400);
});

it("rejects foreign course/task identity and client-invented delayed evidence without writes", async () => {
  const id = randomUUID(), taskId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${f.otherScope.workspaceId},'Foreign course',${id})`;
  expect((await GET(request(id, "GET"), context(id))).status).toBe(404);
  expect((await task(request(id, "GET", `/task?taskId=${taskId}`), context(id))).status).toBe(404);
  const response = await retest(request(id, "POST", "/retest", { goalId: randomUUID(), expectedGoalRevision: 1,
    activityId: randomUUID(), expectedPathVersion: 1, observationId: randomUUID(), clientKey: randomUUID(), minutes: 20 }), context(id));
  expect(response.status).toBe(404);
  const [count] = await f.sql`SELECT count(*)::int AS count FROM opening_retest_activities WHERE workspace_id=${f.scope.workspaceId}`;
  expect(count!.count).toBe(0);
});
