import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET, POST } from "../../../apps/web/src/app/api/opening/planning/long-term/route";
import { POST as lifecycle } from "../../../apps/web/src/app/api/opening/planning/long-term/lifecycle/route";
import { createLearningGoalInTx } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
let f: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await f?.close(); });
const post = (body: unknown, cookie = f.cookie) => new Request("http://localhost/api/opening/planning/long-term", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
it("requires actual authentication before any shared budget or lifecycle operation", async () => {
  expect((await GET(new Request("http://localhost/api/opening/planning/long-term"))).status).toBe(401);
  expect((await POST(post({ action: "settings", dailyMinutes: 60, bufferMinutes: 5, expectedRevision: 0 }, ""))).status).toBe(401);
});
it("scopes the shared budget and returns a no-store truthful overview", async () => {
  const result = await POST(post({ action: "settings", dailyMinutes: 60, bufferMinutes: 5, expectedRevision: 0 }));
  expect(result.status).toBe(200); expect(result.headers.get("Cache-Control")).toBe("no-store");
  const body = await result.json(); expect(body.overview.budget).toMatchObject({ dailyMinutes: 60, bufferMinutes: 5, revision: 1 });
  const other = await f.sql`SELECT learning_management FROM workspace_preferences WHERE workspace_id=${f.otherScope.workspaceId}`;
  expect(other[0]?.learning_management ?? null).toBeNull();
  expect((await POST(post({ action: "settings", dailyMinutes: 90, bufferMinutes: 5, expectedRevision: 0 }))).status).toBe(409);
});
it("refuses another workspace's goal lifecycle without changing its history or task state", async () => {
  const courseId = randomUUID(); await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.otherScope.workspaceId},'Foreign',${courseId})`;
  const goal = await f.sql.begin(tx => createLearningGoalInTx(tx, f.otherScope, { courseIds: [courseId], title: "Foreign goal", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 0, priority: 0, learningMode: "auto", successCriteria: "", clientKey: randomUUID() }));
  expect((await lifecycle(post({ goalId: goal.id, expectedRevision: goal.revision, lifecycle: "archived", acceptedPolicy: "keep" }))).status).toBe(404);
  const [stored] = await f.sql`SELECT lifecycle,revision FROM course_goals WHERE id=${goal.id}`;
  expect(stored).toMatchObject({ lifecycle: "active", revision: 1 });
});
