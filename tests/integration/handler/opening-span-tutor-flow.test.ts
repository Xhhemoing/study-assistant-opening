import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningObservation, Scope } from "@aistudy/contracts";
import { createOpeningAdaptivePrefsRepository, createOpeningLearningRepository, createOpeningSpanSessionRepository, createWorkspacePreferencesRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createSpanTutorNextAction } from "../../../apps/worker/src/runtime/span-tutor-next-action";
import { prepareTutorNextAction } from "../../../apps/worker/src/jobs/tutor-next-action";
import { createSpanLessonSessionService } from "../../../apps/web/src/features/opening/teaching/span/lesson-session-service";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { POST as automaticRetest } from "../../../apps/web/src/app/api/opening/teaching/span/delayed/automatic/route";
import { PATCH as updateTask } from "../../../apps/web/src/app/api/opening/tasks/[id]/route";
import { GET as readLesson, POST as createLesson, PATCH as saveLesson } from "../../../apps/web/src/app/api/opening/teaching/span/lesson/route";
import { POST as presentation } from "../../../apps/web/src/app/api/opening/teaching/span/presentation/route";
import { POST as hint } from "../../../apps/web/src/app/api/opening/teaching/span/hint/route";
import { POST as nextActivity } from "../../../apps/web/src/app/api/opening/teaching/span/next/route";
import { backupRows } from "../opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";

let fixture: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeEach(async () => {
  vi.stubEnv("OPENING_TEACHING_LOOP", "1");
  // Exposure history is workspace-scoped, so each learner flow needs its own
  // identity rather than inheriting earlier tests' delivered question families.
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
afterEach(async () => {
  setAuthRuntimeForTests(null); vi.unstubAllEnvs();
  try { await runtime?.close(); }
  finally { await fixture?.close(); }
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

async function persistedCourse(courseId: string) {
  const { sql, scope } = fixture;
  return {
    activities: await sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId} ORDER BY id`,
    sessions: await sql`SELECT * FROM opening_learning_sessions WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId} ORDER BY id`,
    attempts: await sql`SELECT * FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId} ORDER BY id`,
    observations: await sql`SELECT * FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId} ORDER BY id`,
    help: await sql`SELECT * FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId} ORDER BY id`,
    tasks: await sql`SELECT * FROM opening_tasks WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId} ORDER BY id`,
    retests: await sql`SELECT * FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId} ORDER BY id`,
    decisions: await sql`SELECT * FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
    money: await sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
  };
}
function lessonGet(courseId: string, activityId?: string, retestId?: string) {
  const url = new URL("http://localhost/api/opening/teaching/span/lesson");
  url.searchParams.set("courseId", courseId);
  if (activityId) url.searchParams.set("activityId", activityId);
  if (retestId) url.searchParams.set("retestId", retestId);
  return new Request(url, { headers: { cookie: fixture.cookie } });
}

describe("authenticated span tutor learning flow", () => {
  it("restores a paused lesson by ordinary GET after leaving, then executes and reads its actual correction", async () => {
    const f = await start();
    const pause = await saveLesson(new Request(`http://localhost/api/opening/teaching/span/lesson?activityId=${f.origin.activityId}`, {
      method: "PATCH", headers: { cookie: fixture.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: f.origin.revision, intent: f.origin.intent, moveId: f.origin.moveId, status: "paused" }),
    }));
    expect(pause.status).toBe(200);
    const paused = await pause.json();
    expect(paused).toMatchObject({ activityId: f.origin.activityId, sessionId: f.origin.sessionId, status: "paused", revision: f.origin.revision + 1 });
    const beforeReads = await persistedCourse(f.courseId);
    // No activity id or retained service object: the normal course GET must find the saved lesson.
    const reopened = await readLesson(lessonGet(f.courseId));
    expect(reopened.status).toBe(200); expect(reopened.headers.get("cache-control")).toBe("no-store");
    const restored = await reopened.json();
    expect(restored.session).toEqual(paused);
    expect(restored.attempts).toHaveLength(1);
    const attempt = restored.attempts[0];
    expect(attempt).toMatchObject({ sessionId: f.origin.sessionId, spanExercise: { id: "span-reserved-fraction" } });
    expect((await (await readLesson(lessonGet(f.courseId, f.origin.activityId))).json()).attempts.map((row: { id: string }) => row.id)).toEqual([attempt.id]);
    expect(await persistedCourse(f.courseId)).toEqual(beforeReads);
    const resume = await saveLesson(new Request(`http://localhost/api/opening/teaching/span/lesson?activityId=${f.origin.activityId}`, {
      method: "PATCH", headers: { cookie: fixture.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: paused.revision, intent: paused.intent, moveId: paused.moveId, status: "active" }),
    }));
    expect(resume.status).toBe(200); const active = await resume.json();
    const submitted = await submitAttempt(request(`/api/opening/attempts/${attempt.id}/submit`, {
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "not_in_span" }), outcome: "unverified", assistance: "independent",
    }), { params: Promise.resolve({ id: attempt.id }) });
    expect(submitted.status).toBe(201); const observed = await submitted.json() as LearningObservation;
    expect(observed).toMatchObject({ outcome: "incorrect", sessionId: f.origin.sessionId, serverEvaluation: { decision: "incorrect" } });
    const nextBody = { activityId: f.origin.activityId, expectedRevision: active.revision, observationId: observed.id, clientKey: randomUUID() };
    const response = await nextActivity(request(nextPath, nextBody));
    expect(response.status).toBe(200); const next = await response.json();
    expect(next).toMatchObject({ kind: "ready", resumed: false, courseId: f.courseId });
    expect(next.activityId).not.toBe(f.origin.activityId);
    expect(next.href).toBe(`/opening/courses/${f.courseId}/study/span?lesson=${next.activityId}`);
    const worked = await presentation(request("/api/opening/teaching/span/presentation", {
      sessionId: next.sessionId, courseId: f.courseId, sourceId: f.sourceId, kind: "worked", clientKey: randomUUID(),
    }));
    expect(worked.status).toBe(200); const presented = await worked.json();
    const afterWork = await persistedCourse(f.courseId);
    const finalRead = await readLesson(lessonGet(f.courseId));
    expect(finalRead.status).toBe(200); const final = await finalRead.json();
    expect(final.session).toMatchObject({ activityId: next.activityId, sessionId: next.sessionId, moveId: "self-example", status: "active", retestId: null });
    expect(final.attempts).toHaveLength(1);
    const finalAttempt = final.attempts[0];
    expect(finalAttempt).toMatchObject({ sessionId: next.sessionId,
      spanExercise: { id: presented.problem.id, version: presented.problem.version } });
    const [persistedAttempt] = await fixture.sql`SELECT problem_id,item_version_id FROM opening_learning_attempts
      WHERE id=${finalAttempt.id} AND workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}
        AND session_id=${next.sessionId}`;
    expect(persistedAttempt).toBeDefined();
    expect(persistedAttempt!.problem_id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    expect(persistedAttempt!.item_version_id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    expect(finalAttempt).toMatchObject({ problemId: persistedAttempt!.problem_id, itemVersionId: persistedAttempt!.item_version_id });
    expect(presented.exposureReceipt.contextAnchor).toMatchObject({ courseId: f.courseId, attemptId: finalAttempt.id,
      itemVersionId: persistedAttempt!.item_version_id, purpose: "learning_help" });
    expect(final.assistance[finalAttempt.id]).toBe("revealed");
    expect(afterWork.help).toHaveLength(1);
    expect(afterWork.help[0]).toMatchObject({ id: presented.exposureReceipt.id, delivered: true, level: "revealed",
      course_id: f.courseId, session_id: next.sessionId, attempt_id: finalAttempt.id, problem_id: persistedAttempt!.problem_id });
    expect(afterWork.observations.find(row => row.id === observed.id)).toMatchObject({ outcome: "incorrect", assistance: "independent" });
    expect(afterWork.activities.find(row => row.id === f.origin.activityId)?.status).toBe("completed");
    expect(afterWork.activities).toHaveLength(2);
    const replay = await nextActivity(request(nextPath, nextBody));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ kind: "ready", resumed: true, activityId: next.activityId, sessionId: next.sessionId });
    expect(await persistedCourse(f.courseId)).toEqual(afterWork);
  });

  it("keeps a learner-cancelled bound retest cancelled across ordinary reads, schedule replay and next", async () => {
    const f = await start();
    const initial = await readLesson(lessonGet(f.courseId));
    expect(initial.status).toBe(200); const restored = await initial.json();
    const attempt = restored.attempts[0];
    const submitted = await submitAttempt(request(`/api/opening/attempts/${attempt.id}/submit`, {
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "not_in_span" }), outcome: "unverified", assistance: "independent",
    }), { params: Promise.resolve({ id: attempt.id }) });
    expect(submitted.status).toBe(201); const observed = await submitted.json() as LearningObservation;
    const scheduleBody = { observationId: observed.id, clientKey: randomUUID(), expectedGrantRevision: 1 };
    const scheduled = await automaticRetest(request("/api/opening/teaching/span/delayed/automatic", scheduleBody));
    expect(scheduled.status).toBe(200); const retest = await scheduled.json();
    expect(retest).toMatchObject({ activityStatus: "accepted", taskStatus: "pending" });
    const bound = await createLesson(request("/api/opening/teaching/span/lesson", {
      courseId: f.courseId, sourceIds: [f.sourceId], intent: f.origin.intent, clientKey: randomUUID(), retestId: retest.activityId,
    }));
    expect(bound.status).toBe(200); const lesson = await bound.json();
    // Automatic undo intentionally refuses an already-bound lesson. The task's
    // real learner status endpoint owns explicit cancellation in this lifecycle.
    const [task] = await fixture.sql`SELECT version FROM opening_tasks WHERE id=${retest.taskId} AND workspace_id=${fixture.scope.workspaceId}`;
    const cancel = await updateTask(new Request(`http://localhost/api/opening/tasks/${retest.taskId}`, {
      method: "PATCH", headers: { cookie: fixture.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: Number(task!.version), status: "skipped", at: new Date().toISOString() }),
    }), { params: Promise.resolve({ id: retest.taskId }) });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ id: retest.taskId, status: "skipped" });
    const cancelled = await persistedCourse(f.courseId);
    expect(cancelled.retests.find(row => row.id === retest.activityId)?.status).toBe("cancelled");
    expect(cancelled.tasks.find(row => row.id === retest.taskId)).toMatchObject({ status: "skipped", close_source: "learner" });
    expect(cancelled.attempts.filter(row => row.session_id === lesson.sessionId)).toEqual([]);
    const reopened = await readLesson(lessonGet(f.courseId, lesson.activityId, retest.activityId));
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ session: { activityId: lesson.activityId, retestId: retest.activityId },
      attempts: [], agenda: { status: "cancelled", resumable: false, pendingRetestId: retest.activityId } });
    const again = await automaticRetest(request("/api/opening/teaching/span/delayed/automatic", scheduleBody));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ activityId: retest.activityId, taskId: retest.taskId, activityStatus: "cancelled", taskStatus: "skipped" });
    const next = await nextActivity(request(nextPath, { activityId: lesson.activityId, expectedRevision: lesson.revision, observationId: null, clientKey: randomUUID() }));
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ kind: "choice", reason: "cancelled",
      primary: { href: `/opening/courses/${f.courseId}#course-learning-records` },
      secondary: { href: `/opening/courses/${f.courseId}/study/span?lesson=${lesson.activityId}&retest=${retest.activityId}` } });
    const lastRead = await readLesson(lessonGet(f.courseId, lesson.activityId, retest.activityId));
    expect(lastRead.status).toBe(200);
    expect(await lastRead.json()).toMatchObject({ session: { activityId: lesson.activityId, retestId: retest.activityId },
      attempts: [], agenda: { status: "cancelled", resumable: false } });
    expect(await persistedCourse(f.courseId)).toEqual(cancelled);
  });

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
