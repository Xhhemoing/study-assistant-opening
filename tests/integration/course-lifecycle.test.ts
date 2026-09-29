import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCourseMembershipRepository, createOpeningJobRepository, createOpeningPlansRepository, createOpeningRetestActivityRepository, createOpeningRetestRepository, createWorkspacePreferencesRepository, readLearningPreferences, setCourseLearningPreferences } from "@aistudy/database";
import { createAuthRuntime, type AuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";
import { GET as listCourses } from "../../apps/web/src/app/api/courses/route";
import * as courseRoute from "../../apps/web/src/app/api/courses/[id]/route";
import { DELETE as removeMembership } from "../../apps/web/src/app/api/courses/[id]/memberships/route";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

const enabled = { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true };
describe("course lifecycle through authenticated routes", () => {
  let f: OpeningFixture, runtime: AuthRuntime;
  beforeAll(async () => {
    f = await createOpeningFixture();
    runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!,
      authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
      sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
    setAuthRuntimeForTests(runtime);
  });
  afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await f?.close(); });
  const request = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost${path}`, {
    method, headers: { cookie: f.cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const context = (id: string) => ({ params: Promise.resolve({ id }) });

  it("makes archived courses discoverable only with an explicit list choice", async () => {
    const course = await runtime.courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Archived", slug: randomUUID() });
    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${course.id}`;
    const ordinary = await (await listCourses(request("/api/courses"))).json();
    expect(ordinary.courses.some((row: { id: string }) => row.id === course.id)).toBe(false);
    const all = await (await listCourses(request("/api/courses?includeArchived=true"))).json();
    expect(all.courses.find((row: { id: string }) => row.id === course.id)).toMatchObject({ archivedAt: expect.any(String) });
  });

  it("returns stored course restrictions even when the account is disabled", async () => {
    const course = await runtime.courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Restrictions", slug: randomUUID() });
    await setCourseLearningPreferences(f.sql, f.scope, course.id, { retestSuggestionsEnabled: false });
    const response = await courseRoute.GET(request(`/api/courses/${course.id}`), context(course.id));
    expect((await response.json()).course.learningPreferenceOverrides).toEqual({ retestSuggestionsEnabled: false });
    expect(await readLearningPreferences(f.sql, f.scope, course.id)).toEqual({ assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  });

  it("archives and restores without losing facts, tasks, sources or replaying queued suggestions", async () => {
    await createWorkspacePreferencesRepository(f.sql).setLearningPreferences(f.scope, enabled);
    const learning = await learningAttemptFixture(f);
    const observation = await learning.submit(await learning.start());
    const task = await createOpeningPlansRepository(f.sql).createTask(f.scope, {
      title: "Accepted practice", minutes: 20, dueAt: null, priority: 1, candidateId: null, clientKey: randomUUID(),
    });
    const activities = createOpeningRetestActivityRepository(f.sql);
    const proposed = await activities.createProposed(f.scope, { cycleId: randomUUID(), taskId: task.id,
      courseId: learning.courseId, skillLabel: "fractions", proposedAt: new Date().toISOString() });
    await activities.accept(f.scope, proposed.activityId, task.id, new Date().toISOString());
    const queued = await createOpeningJobRepository(f.sql).createOnce(f.scope, {
      key: randomUUID(), kind: "retest", payload: { courseId: learning.courseId }, privacyEpoch: 0,
    });
    const patch = courseRoute.PATCH;
    const archived = await patch(request(`/api/courses/${learning.courseId}`, "PATCH", { archived: true }), context(learning.courseId));
    expect(archived.status).toBe(200);
    const archivedAt = (await archived.json()).course.archivedAt;
    expect(archivedAt).toEqual(expect.any(String));
    expect(await readLearningPreferences(f.sql, f.scope, learning.courseId)).toEqual({ assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
    const repeated = await patch(request(`/api/courses/${learning.courseId}`, "PATCH", { archived: true }), context(learning.courseId));
    expect((await repeated.json()).course.archivedAt).toBe(archivedAt);
    const restored = await patch(request(`/api/courses/${learning.courseId}`, "PATCH", { archived: false }), context(learning.courseId));
    expect(restored.status).toBe(200);
    expect((await restored.json()).course.archivedAt).toBeNull();
    expect((await activities.get(f.scope, proposed.activityId)).status).toBe("accepted");
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${learning.sourceId}`).toHaveLength(1);
    expect(await f.sql`SELECT id FROM opening_learning_observations WHERE id=${observation.id}`).toHaveLength(1);
    expect(await f.sql`SELECT id FROM opening_tasks WHERE id=${task.id} AND status='pending'`).toHaveLength(1);
    expect(await createOpeningRetestRepository(f.sql).saveCandidates(f.scope, [{ id: randomUUID(), courseId: learning.courseId,
      skillLabel: "fractions", sourceIds: [learning.sourceId], prompt: "Try again", dueAt: new Date().toISOString(), accepted: false }], 0, queued.id)).toEqual([]);
  });

  it("keeps another course relationship and the original source when unlinking", async () => {
    const learning = await learningAttemptFixture(f), courses = createCourseMembershipRepository(f.sql);
    const other = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Second", slug: randomUUID() });
    for (const courseId of [learning.courseId, other.id]) await courses.addAssetMembership({
      workspaceId: f.scope.workspaceId, courseId, assetType: "source", assetId: learning.sourceId, role: "core", visibility: "private",
    });
    const removed = await removeMembership(request(`/api/courses/${learning.courseId}/memberships`, "DELETE", {
      assetType: "source", assetId: learning.sourceId,
    }), context(learning.courseId));
    expect(removed.status).toBe(204);
    expect(await courses.listCourseAssets({ workspaceId: f.scope.workspaceId, courseId: learning.courseId })).toEqual([]);
    expect(await courses.listCourseAssets({ workspaceId: f.scope.workspaceId, courseId: other.id })).toHaveLength(1);
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${learning.sourceId}`).toHaveLength(1);
  });

  it("rejects unauthenticated, foreign-course and malformed archive requests", async () => {
    const other = await runtime.courses.createCourse({ workspaceId: f.otherScope.workspaceId, title: "Foreign", slug: randomUUID() });
    const patch = courseRoute.PATCH;
    expect((await patch(new Request(`http://localhost/api/courses/${other.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) }), context(other.id))).status).toBe(401);
    expect((await patch(request(`/api/courses/${other.id}`, "PATCH", { archived: true }), context(other.id))).status).toBe(404);
    expect((await patch(request(`/api/courses/${other.id}`, "PATCH", { archived: "yes" }), context(other.id))).status).toBe(400);
    expect((await listCourses(request("/api/courses?includeArchived=garbage"))).status).toBe(400);
    expect((await runtime.courses.getCourse({ workspaceId: f.otherScope.workspaceId, courseId: other.id })).archivedAt).toBeNull();
  });
});
