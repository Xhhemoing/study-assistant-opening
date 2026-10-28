import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningObservation, Scope } from "@aistudy/contracts";
import { createOpeningAdaptivePrefsRepository, createOpeningLearningRepository, createOpeningSpanSessionRepository, createWorkspacePreferencesRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createSpanTutorNextAction } from "../../../apps/worker/src/runtime/span-tutor-next-action";
import { prepareTutorNextAction } from "../../../apps/worker/src/jobs/tutor-next-action";
import { createSpanLessonSessionService } from "../../../apps/web/src/features/opening/teaching/span/lesson-session-service";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { POST as automaticRetest } from "../../../apps/web/src/app/api/opening/teaching/span/delayed/automatic/route";
import { POST as presentation } from "../../../apps/web/src/app/api/opening/teaching/span/presentation/route";
import { POST as hint } from "../../../apps/web/src/app/api/opening/teaching/span/hint/route";
import { POST as nextActivity } from "../../../apps/web/src/app/api/opening/teaching/span/next/route";
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
const request = (path: string, body: unknown, cookie = fixture.cookie) => new Request(`http://localhost${path}`, {
  method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
});
const nextPath = "/api/opening/teaching/span/next";

async function start(scope: Scope = fixture.scope) {
  const rows = backupRows(fixture.sql, scope), sourceId = await rows.source(), courseId = randomUUID();
  await rows.chunk(sourceId);
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Span real flow',${courseId})`;
  await fixture.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(scope,
    { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  await createOpeningAdaptivePrefsRepository(fixture.sql).patch(scope, {
    spanTutorGrant: { courseId, enabled: true, dailyMinutes: 180, expiresOn: null, expectedRevision: 0 },
  });
  const prepared = await prepareTutorNextAction(createSpanTutorNextAction(fixture.sql), scope, {
    courseId, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 }, question: "开始学习 span",
    userTurnId: randomUUID(), operationId: `handler-flow:${randomUUID()}`,
  });
  expect(prepared).toMatchObject({ resumed: false, decision: { activityKind: "diagnose" } });
  if (!prepared?.action) throw new Error("The real tutor service did not produce an executable span activity");
  const lessons = createOpeningSpanSessionRepository(fixture.sql);
  const origin = await lessons.get(scope, prepared.action.activityId);
  if (!origin) throw new Error("The tutor action has no persisted span session");
  expect(prepared.action.href).toBe(`/opening/courses/${courseId}/study/span?lesson=${origin.activityId}`);
  return { sourceId, courseId, origin, lessons };
}

async function retestState(activityId: string) {
  return fixture.sql`SELECT r.id,r.status AS retest_status,r.version AS retest_version,r.not_before_at,r.learning_protocol,
    t.id AS task_id,t.status AS task_status,t.version AS task_version,t.close_source
    FROM opening_retest_activities r JOIN opening_tasks t ON t.id=r.task_id
      AND t.workspace_id=r.workspace_id AND t.owner_user_id=r.owner_user_id
    WHERE r.id=${activityId} AND r.workspace_id=${fixture.scope.workspaceId} AND r.owner_user_id=${fixture.scope.ownerUserId}`;
}

describe("authenticated span tutor learning flow", () => {
  it("issues and scores a real unseen question, schedules its retest, then creates and replays ordinary correction", async () => {
    const f = await start();
    // Consume the attempt already issued atomically by the tutor, exactly as page restoration does.
    const details = await createSpanLessonSessionService(fixture.sql).read(fixture.scope, f.courseId, f.origin.activityId);
    expect(details.session?.sessionId).toBe(f.origin.sessionId);
    expect(details.attempts).toHaveLength(1);
    const issued = details.attempts[0];
    if (!issued) throw new Error("The persisted tutor activity has no executable restored attempt");
    const restored = await createSpanLessonSessionService(fixture.sql).read(fixture.scope, f.courseId, f.origin.activityId);
    expect(restored.attempts.map(attempt => attempt.id)).toEqual([issued.id]);
    expect(issued.spanExercise?.id).toBe("span-reserved-fraction");
    expect(issued.spanValidation).toMatchObject({ eligible: true, firstFamilyExposure: true });
    const submitted = await submitAttempt(request(`/api/opening/attempts/${issued.id}/submit`, {
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "not_in_span" }), outcome: "unverified", assistance: "independent",
    }), { params: Promise.resolve({ id: issued.id }) });
    expect(submitted.status).toBe(201);
    const observation = await submitted.json() as LearningObservation;
    expect(observation).toMatchObject({ courseId: f.courseId, sessionId: f.origin.sessionId, outcome: "incorrect",
      serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "incorrect" } });

    const scheduled = await automaticRetest(request("/api/opening/teaching/span/delayed/automatic", {
      observationId: observation.id, clientKey: randomUUID(), expectedGrantRevision: 1,
    }));
    expect(scheduled.status).toBe(200);
    expect(scheduled.headers.get("cache-control")).toBe("no-store");
    const retest = await scheduled.json();
    expect(retest).toMatchObject({ courseId: f.courseId, taskStatus: "pending", activityStatus: "accepted" });
    expect(Date.parse(retest.notBeforeAt)).toBeGreaterThanOrEqual(Math.max(Date.parse(observation.recordedAt!), Date.parse(observation.submittedAt!)) + 72 * 3600000);
    const before = await retestState(retest.activityId);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ retest_status: "accepted", task_status: "pending", task_id: retest.taskId });

    const body = { activityId: f.origin.activityId, expectedRevision: f.origin.revision, observationId: observation.id, clientKey: randomUUID() };
    const response = await nextActivity(request(nextPath, body));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const next = await response.json();
    expect(next).toMatchObject({ kind: "ready", courseId: f.courseId, resumed: false });
    expect(next.href).toBe(`/opening/courses/${f.courseId}/study/span?lesson=${next.activityId}`);
    const correction = await f.lessons.get(fixture.scope, next.activityId);
    expect(correction).toMatchObject({ activityId: next.activityId, sessionId: next.sessionId, courseId: f.courseId,
      moveId: "self-example", retestId: null, status: "active" });
    const [ownership] = await fixture.sql`SELECT workspace_id,owner_user_id FROM opening_teaching_activities WHERE id=${next.activityId}`;
    expect(ownership).toMatchObject({ workspace_id: fixture.scope.workspaceId, owner_user_id: fixture.scope.ownerUserId });
    const refreshed = (await f.lessons.get(fixture.scope, f.origin.activityId))!;
    expect(refreshed.status).toBe("completed");
    expect(refreshed.revision).toBeGreaterThan(f.origin.revision);
    const replay = await nextActivity(request(nextPath, { ...body, expectedRevision: refreshed.revision, clientKey: randomUUID() }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ kind: "ready", activityId: next.activityId, courseId: f.courseId, resumed: true });
    expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(2);
    expect(await retestState(retest.activityId)).toEqual(before);

    // Retracting the origin must stop recommending its derived correction without erasing history.
    const presentationPath = "/api/opening/teaching/span/presentation";
    const presentationBody = { sessionId: next.sessionId, courseId: f.courseId, sourceId: f.sourceId,
      kind: "worked", clientKey: `flow-presentation:${randomUUID()}` };
    const presented = await presentation(request(presentationPath, presentationBody));
    expect(presented.status).toBe(200);
    const oldPresentation = await presented.json();
    const correctionBefore = await f.lessons.get(fixture.scope, next.activityId);
    const activityBefore = await fixture.sql`SELECT * FROM opening_teaching_activities WHERE id=${next.activityId}`;
    const attemptsBefore = await fixture.sql`SELECT * FROM opening_learning_attempts WHERE activity_id=${next.activityId} ORDER BY id`;
    await createOpeningLearningRepository(fixture.sql).reviseObservation(fixture.scope, {
      rootObservationId: observation.rootObservationId ?? observation.id, revisesObservationId: observation.id,
      expectedHead: observation.id, revisionKind: "retract", reason: "withdraw incorrect evidence", clientKey: randomUUID(),
    });
    const changed = await createSpanLessonSessionService(fixture.sql).read(fixture.scope, f.courseId, next.activityId);
    expect(changed).toMatchObject({ originChange: { reason: "evidence_changed", observationId: null,
      originSession: { activityId: f.origin.activityId, revision: refreshed.revision } } });
    const historicalReplay = await nextActivity(request(nextPath, body));
    expect(historicalReplay.status).toBe(200);
    expect(await historicalReplay.json()).toMatchObject({ kind: "choice", reason: "evidence_changed" });
    const resumed = await prepareTutorNextAction(createSpanTutorNextAction(fixture.sql), fixture.scope, {
      courseId: f.courseId, sourceIds: [f.sourceId], sourceVersions: { [f.sourceId]: 1 }, question: "继续学习",
      userTurnId: randomUUID(), operationId: `handler-resume:${randomUUID()}`,
    });
    expect(resumed).toMatchObject({ action: null });
    expect(resumed?.choice?.href).toContain(`/opening/courses/${f.courseId}`);
    const oldHelp = await presentation(request(presentationPath, presentationBody));
    expect(oldHelp.status).toBe(200);
    expect(await oldHelp.json()).toEqual(oldPresentation);
    const staleNewPresentation = await presentation(request(presentationPath, { ...presentationBody, clientKey: randomUUID() }));
    expect(staleNewPresentation.status).toBe(409);
    expect(attemptsBefore).toHaveLength(1);
    const staleNewHint = await hint(request("/api/opening/teaching/span/hint", { attemptId: attemptsBefore[0]!.id, level: 1 }));
    expect(staleNewHint.status).toBe(409);
    expect(await f.lessons.get(fixture.scope, next.activityId)).toEqual(correctionBefore);
    expect(await fixture.sql`SELECT * FROM opening_teaching_activities WHERE id=${next.activityId}`).toEqual(activityBefore);
    expect(await fixture.sql`SELECT * FROM opening_learning_attempts WHERE activity_id=${next.activityId} ORDER BY id`).toEqual(attemptsBefore);
    const savedOldAnswer = await submitAttempt(request(`/api/opening/attempts/${attemptsBefore[0]!.id}/submit`, {
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "not_in_span" }), outcome: "unverified", assistance: "independent",
    }), { params: Promise.resolve({ id: String(attemptsBefore[0]!.id) }) });
    expect(savedOldAnswer.status).toBe(201);
    expect(await savedOldAnswer.json()).toMatchObject({ courseId: f.courseId, sessionId: next.sessionId });
    expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(2);
  });
  it("requires authentication for continuation before creating another activity", async () => {
    const response = await nextActivity(request(nextPath, { activityId: randomUUID(), expectedRevision: 1, observationId: null, clientKey: randomUUID() }, ""));
    expect(response.status).toBe(401);
  });
  it("refuses another user's real origin and leaves its session and task count unchanged", async () => {
    const f = await start(fixture.otherScope);
    const response = await nextActivity(request(nextPath, {
      activityId: f.origin.activityId, expectedRevision: f.origin.revision, observationId: null, clientKey: randomUUID(),
    }));
    expect(response.status).toBe(404);
    expect(await f.lessons.get(fixture.otherScope, f.origin.activityId)).toEqual(f.origin);
    expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
    expect(await fixture.sql`SELECT id FROM opening_tasks WHERE course_id=${f.courseId}`).toHaveLength(0);
  });
});
