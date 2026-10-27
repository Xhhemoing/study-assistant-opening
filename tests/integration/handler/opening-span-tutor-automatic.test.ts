import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningAdaptivePrefsRepository, createOpeningLearningAttemptRepository,
  createOpeningLearningRepository, createWorkspacePreferencesRepository } from "@aistudy/database";
import { getSpanProblem, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST } from "../../../apps/web/src/app/api/opening/teaching/span/delayed/automatic/route";
import { backupRows } from "../opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";

let fixture: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
beforeEach(() => { vi.stubEnv("OPENING_TEACHING_LOOP", "1"); });
afterAll(async () => {
  setAuthRuntimeForTests(null); vi.unstubAllEnvs();
  await runtime?.close(); await fixture?.close();
});
const request = (body: unknown, cookie = fixture.cookie) => new Request("http://localhost/api/opening/teaching/span/delayed/automatic", {
  method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
});

/** Reuses the guarded fixture and source helpers; the baseline is scored by the real span repository. */
async function baseline(scope = fixture.scope) {
  const rows = backupRows(fixture.sql, scope), sourceId = await rows.source(), courseId = randomUUID();
  await rows.chunk(sourceId);
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Automatic span handler',${courseId})`;
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(scope,
    { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  await createOpeningAdaptivePrefsRepository(fixture.sql).patch(scope, {
    spanTutorGrant: { courseId, enabled: true, dailyMinutes: 30, expiresOn: null, expectedRevision: 0 },
  });
  const learning = createOpeningLearningRepository(fixture.sql);
  const session = await learning.createSession(scope, { courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId] });
  const problem = getSpanProblem("span-example-2d")!;
  const attempt = await createOpeningLearningAttemptRepository(fixture.sql).create(scope, { sessionId: session.id,
    clientKey: randomUUID(), spanExercise: { sourceId, problemId: problem.id, version: 1 } });
  const record = await learning.insertObservation(scope, { sessionId: session.id, courseId, skillLabel: SPAN_SKILL_LABEL,
    sourceIds: [sourceId], attemptId: attempt.id, problemId: attempt.problemId, clientKey: randomUUID(),
    assistance: "independent", outcome: "unverified", verdictSource: "self_report",
    answer: JSON.stringify({ membership: "in_span", coefficients: ["3", "-1/2"], equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: ["3", "-1"] }) });
  expect(record.serverEvaluation).toMatchObject({ evaluatorVersion: "span-exact-v1", decision: "correct" });
  return { courseId, body: { observationId: record.id, clientKey: randomUUID(), expectedGrantRevision: 1 } };
}

describe("authenticated automatic span retest", () => {
  it("requires a real authenticated workspace before accepting an observation", async () => {
    const response = await POST(request({ observationId: randomUUID(), clientKey: randomUUID(), expectedGrantRevision: 1 }, ""));
    expect(response.status).toBe(401);
  });
  it("rejects another user's observation without creating a task in either workspace", async () => {
    const f = await baseline(fixture.otherScope);
    const response = await POST(request(f.body));
    expect(response.status).toBe(404);
    expect(await fixture.sql`SELECT id FROM opening_tasks WHERE course_id=${f.courseId}`).toHaveLength(0);
    expect(await fixture.sql`SELECT id FROM opening_retest_activities WHERE course_id=${f.courseId}`).toHaveLength(0);
  });
  it("accepts the authorized caller's baseline with a non-cacheable owned receipt and stable replay", async () => {
    const f = await baseline(), response = await POST(request(f.body));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result).toMatchObject({ courseId: f.courseId, taskStatus: "pending", activityStatus: "accepted" });
    expect(result.href).toBe(`/opening/courses/${f.courseId}/study/span?retest=${result.activityId}`);
    const [task] = await fixture.sql`SELECT workspace_id,owner_user_id,course_id FROM opening_tasks WHERE id=${result.taskId}`;
    expect(task).toMatchObject({ workspace_id: fixture.scope.workspaceId, owner_user_id: fixture.scope.ownerUserId, course_id: f.courseId });
    const replay = await POST(request(f.body));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ taskId: result.taskId, activityId: result.activityId, courseId: f.courseId });
    expect(await fixture.sql`SELECT id FROM opening_tasks WHERE course_id=${f.courseId}`).toHaveLength(1);
  });
  it("refuses a new automatic task after the course grant is closed", async () => {
    const f = await baseline();
    await createOpeningAdaptivePrefsRepository(fixture.sql).patch(fixture.scope, {
      spanTutorGrant: { courseId: f.courseId, enabled: false, dailyMinutes: 30, expiresOn: null, expectedRevision: 1 },
    });
    const response = await POST(request({ ...f.body, expectedGrantRevision: 2 }));
    expect(response.status).toBe(409);
    expect(await fixture.sql`SELECT id FROM opening_tasks WHERE course_id=${f.courseId}`).toHaveLength(0);
    expect(await fixture.sql`SELECT id FROM opening_retest_activities WHERE course_id=${f.courseId}`).toHaveLength(0);
  });
});
