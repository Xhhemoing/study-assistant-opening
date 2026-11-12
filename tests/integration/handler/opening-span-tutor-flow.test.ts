import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningObservation, Scope, SpanProblem } from "@aistudy/contracts";
import { createOpeningAdaptivePrefsRepository, createOpeningLearningRepository, createOpeningSpanSessionRepository, createWorkspacePreferencesRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createSpanTutorNextAction } from "../../../apps/worker/src/runtime/span-tutor-next-action";
import { prepareTutorNextAction } from "../../../apps/worker/src/jobs/tutor-next-action";
import { createSpanLessonSessionService } from "../../../apps/web/src/features/opening/teaching/span/lesson-session-service";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { POST as createAttempt } from "../../../apps/web/src/app/api/opening/attempts/route";
import { POST as automaticRetest } from "../../../apps/web/src/app/api/opening/teaching/span/delayed/automatic/route";
import { PATCH as updateTask } from "../../../apps/web/src/app/api/opening/tasks/[id]/route";
import { GET as readLesson, POST as createLesson, PATCH as saveLesson } from "../../../apps/web/src/app/api/opening/teaching/span/lesson/route";
import { POST as presentation } from "../../../apps/web/src/app/api/opening/teaching/span/presentation/route";
import { POST as issueRepair } from "../../../apps/web/src/app/api/opening/teaching/span/reserved/route";
import { solveSpanProblem, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import * as spanDomain from "@aistudy/domain";
import { POST as createGoal } from "../../../apps/web/src/app/api/opening/learning-goals/route";
import { PUT as confirmRoute, GET as readRoute } from "../../../apps/web/src/app/api/opening/courses/[id]/learning-route/route";
import { POST as startRoute } from "../../../apps/web/src/app/api/opening/courses/[id]/learning-route/start/route";
import { spanLessonDetailsSchema } from "../../../apps/web/src/features/opening/teaching/span/span-session-client";
import { readSpanNextResult, readSpanPrerequisiteReturnResult } from "../../../apps/web/src/features/opening/teaching/span/span-next-action-control";
import { POST as hint } from "../../../apps/web/src/app/api/opening/teaching/span/hint/route";
import { POST as nextActivity } from "../../../apps/web/src/app/api/opening/teaching/span/next/route";
import { backupRows } from "../opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";

let fixture: OpeningFixture | undefined, runtime: ReturnType<typeof createAuthRuntime> | undefined;
function currentFixture() {
  if (!fixture) throw new Error("Opening fixture is not initialized");
  return fixture;
}
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
  setAuthRuntimeForTests(null); vi.restoreAllMocks(); vi.unstubAllEnvs();
  try { await runtime?.close(); }
  finally {
    try { await fixture?.close(); }
    finally { runtime = undefined; fixture = undefined; }
  }
});
const request = (path: string, body: unknown, cookie = currentFixture().cookie) => new Request(`http://localhost${path}`, {
  method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
});
const patchRequest = (path: string, body: unknown, cookie = currentFixture().cookie) => new Request(`http://localhost${path}`, {
  method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
});
const nextPath = "/api/opening/teaching/span/next";

async function start(scope: Scope = currentFixture().scope) {
  const fixture = currentFixture();
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
  const fixture = currentFixture();
  return fixture.sql`SELECT r.id,r.status AS retest_status,r.version AS retest_version,r.not_before_at,r.learning_protocol,
    t.id AS task_id,t.status AS task_status,t.version AS task_version,t.close_source
    FROM opening_retest_activities r JOIN opening_tasks t ON t.id=r.task_id
      AND t.workspace_id=r.workspace_id AND t.owner_user_id=r.owner_user_id
    WHERE r.id=${activityId} AND r.workspace_id=${fixture.scope.workspaceId} AND r.owner_user_id=${fixture.scope.ownerUserId}`;
}

async function persistedCourse(courseId: string) {
  const { sql, scope } = currentFixture();
  return {
    activities: await sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} ORDER BY id`,
    sessions: await sql`SELECT * FROM opening_learning_sessions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} ORDER BY id`,
    attempts: await sql`SELECT * FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} ORDER BY id`,
    observations: await sql`SELECT * FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} ORDER BY id`,
    help: await sql`SELECT * FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} ORDER BY id`,
    tasks: await sql`SELECT * FROM opening_tasks WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} ORDER BY id`,
    retests: await sql`SELECT * FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} ORDER BY id`,
    decisions: await sql`SELECT * FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} ORDER BY id`,
    money: await sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
  };
}
function lessonGet(courseId: string, activityId?: string, retestId?: string) {
  const fixture = currentFixture();
  const url = new URL("http://localhost/api/opening/teaching/span/lesson");
  url.searchParams.set("courseId", courseId);
  if (activityId) url.searchParams.set("activityId", activityId);
  if (retestId) url.searchParams.set("retestId", retestId);
  return new Request(url, { headers: { cookie: fixture.cookie } });
}

function equationError(problem: SpanProblem) {
  const solved = solveSpanProblem(problem);
  if (solved.kind !== "unique") throw new Error("fixture requires a unique canonical problem");
  return JSON.stringify({ membership: "in_span", coefficients: solved.coefficients,
    equation: { vectors: problem.vectors, target: problem.target.map(() => "0") }, coordinateChecks: problem.target });
}

describe("authenticated span tutor learning flow", () => {
  it("restores a paused lesson by ordinary GET after leaving, then executes and reads its actual correction", async () => {
    const fixture = currentFixture(), f = await start();
    const pause = await saveLesson(patchRequest(`/api/opening/teaching/span/lesson?activityId=${f.origin.activityId}`, {
      expectedRevision: f.origin.revision, intent: f.origin.intent, moveId: f.origin.moveId, status: "paused",
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
    const resume = await saveLesson(patchRequest(`/api/opening/teaching/span/lesson?activityId=${f.origin.activityId}`, {
      expectedRevision: paused.revision, intent: paused.intent, moveId: paused.moveId, status: "active",
    }));
    expect(resume.status).toBe(200); const active = await resume.json();
    const submitted = await submitAttempt(request(`/api/opening/attempts/${attempt.id}/submit`, {
      clientKey: randomUUID(), answer: equationError(attempt.spanExercise), outcome: "unverified", assistance: "independent",
    }), { params: Promise.resolve({ id: attempt.id }) });
    expect(submitted.status).toBe(201); const observed = await submitted.json() as LearningObservation;
    expect(observed).toMatchObject({ outcome: "incorrect", sessionId: f.origin.sessionId, serverEvaluation: { decision: "incorrect", skills: { equation: "incorrect" } } });
    const nextBody = { activityId: f.origin.activityId, expectedRevision: active.revision, observationId: observed.id, clientKey: randomUUID() };
    const response = await nextActivity(request(nextPath, nextBody));
    expect(response.status).toBe(200); const next = await response.json();
    expect(next).toMatchObject({ kind: "ready", resumed: false, courseId: f.courseId });
    expect(next.activityId).not.toBe(f.origin.activityId);
    expect(next.href).toBe(`/opening/courses/${f.courseId}/study/span?lesson=${next.activityId}`);
    const worked = await presentation(request("/api/opening/teaching/span/presentation", {
      activityId: next.activityId, repairVersion: 1, stage: "example", clientKey: randomUUID(),
    }));
    expect(worked.status, JSON.stringify(await worked.clone().json())).toBe(200); const presented = await worked.json();
    const afterWork = await persistedCourse(f.courseId);
    const finalRead = await readLesson(lessonGet(f.courseId));
    expect(finalRead.status).toBe(200); const final = await finalRead.json();
    expect(final.session).toMatchObject({ activityId: next.activityId, sessionId: next.sessionId, moveId: "self-example", status: "active", retestId: null });
    expect(final.repair).toMatchObject({ status: "ready", targetSkill: "equation", prerequisiteStatus: "unknown" });
    expect(presented.targetedExplanation).toMatchObject({ targetSkill: "equation" });
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

    // Continue through the real HTTP stage owner, including P1's explicit same-item retry.
    const move = async (snapshot: typeof final.session, moveId: string) => {
      const response = await saveLesson(patchRequest(`/api/opening/teaching/span/lesson?activityId=${snapshot.activityId}`, {
        expectedRevision: snapshot.revision, intent: snapshot.intent, moveId, status: "active" }));
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200); return response.json();
    };
    const variantSession = await move(final.session, "self-faded");
    const issue = async (stage: string, revision: number, retryAfterAttemptId?: string) => {
      const response = await issueRepair(request("/api/opening/teaching/span/reserved", { activityId: next.activityId,
        repairVersion: 1, expectedRevision: revision, stage, clientKey: randomUUID(), ...(retryAfterAttemptId ? { retryAfterAttemptId } : {}) }));
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200); return response.json();
    };
    const variant = await issue("variant", variantSession.revision);
    const wrongResponse = await submitAttempt(request(`/api/opening/attempts/${variant.id}/submit`, { clientKey: randomUUID(),
      answer: JSON.stringify({ membership: "in_span", coefficients: ["0", "0"] }), outcome: "unverified", assistance: "independent" }), { params: Promise.resolve({ id: variant.id }) });
    expect(wrongResponse.status).toBe(201); const wrong = await wrongResponse.json();
    expect(wrong.serverEvaluation.decision).toBe("incorrect");
    const denied = await saveLesson(patchRequest(`/api/opening/teaching/span/lesson?activityId=${next.activityId}`, {
      expectedRevision: variantSession.revision, intent: variantSession.intent, moveId: "self_study-reserved", status: "active" }));
    expect(denied.status).toBe(409);
    const retried = await issue("variant", variantSession.revision, variant.id);
    expect(retried.id).not.toBe(variant.id);
    expect(await issue("variant", variantSession.revision, variant.id)).toEqual(retried);
    const submitRight = async (attempt: { id: string; spanExercise: SpanProblem }) => {
      const p = attempt.spanExercise, solved = solveSpanProblem(p);
      if (solved.kind !== "unique") throw new Error("expected consistent same-family question");
      const response = await submitAttempt(request(`/api/opening/attempts/${attempt.id}/submit`, { clientKey: randomUUID(),
        answer: JSON.stringify({ membership: "in_span", coefficients: solved.coefficients, equation: { vectors: p.vectors, target: p.target }, coordinateChecks: p.target }),
        outcome: "unverified", assistance: "independent" }), { params: Promise.resolve({ id: attempt.id }) });
      expect(response.status).toBe(201); return response.json();
    };
    expect(await submitRight(retried)).toMatchObject({ assistance: "hinted", serverEvaluation: { decision: "correct", coreEvidenceComplete: true } });
    const confirmationSession = await move(variantSession, "self_study-reserved");
    const confirmation = await issue("confirmation", confirmationSession.revision);
    expect(confirmation.spanExercise.id).not.toBe(retried.spanExercise.id);
    const result = await submitRight(confirmation);
    expect(result).toMatchObject({ assistance: "independent", serverEvaluation: { decision: "correct", coreEvidenceComplete: true } });
    const beforeResultRead = await persistedCourse(f.courseId);
    const resultRead = await readLesson(lessonGet(f.courseId, next.activityId));
    expect(resultRead.status).toBe(200);
    expect((await resultRead.json()).observations).toContainEqual(expect.objectContaining({ id: result.id }));
    expect(await persistedCourse(f.courseId)).toEqual(beforeResultRead);
    expect(beforeResultRead.observations.find(row => row.id === wrong.id)?.answer).toBe(wrong.answer);
  });

  it("restores the most recently updated active or paused lesson, breaking ties by descending activity id", async () => {
    const fixture = currentFixture(), f = await start(), { sql, scope } = fixture;
    const created = await createLesson(request("/api/opening/teaching/span/lesson", {
      courseId: f.courseId, sourceIds: [f.sourceId], intent: f.origin.intent, clientKey: randomUUID(),
    }));
    expect(created.status).toBe(200);
    const second = await created.json();
    expect(second.activityId).not.toBe(f.origin.activityId);
    const candidate = f.origin.activityId < second.activityId ? f.origin : second;
    const pause = await saveLesson(patchRequest(`/api/opening/teaching/span/lesson?activityId=${candidate.activityId}`, {
      expectedRevision: candidate.revision, intent: candidate.intent, moveId: candidate.moveId, status: "paused",
    }));
    expect(pause.status).toBe(200);
    const paused = await pause.json();
    expect(paused).toMatchObject({ activityId: candidate.activityId, status: "paused" });
    // Make the lower id newer, so updated_at must take precedence over id.
    await sql`UPDATE opening_teaching_activities
      SET updated_at=CASE WHEN id=${candidate.activityId} THEN '2026-01-02T00:00:00Z'::timestamptz
        ELSE '2026-01-01T00:00:00Z'::timestamptz END
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${f.courseId}`;
    const beforeRead = await persistedCourse(f.courseId);
    expect(beforeRead.activities).toHaveLength(2);
    expect(beforeRead.activities.map(row => row.status).sort()).toEqual(["active", "paused"]);
    const reopened = await readLesson(lessonGet(f.courseId));
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ session: { activityId: candidate.activityId, status: "paused" } });
    expect(await persistedCourse(f.courseId)).toEqual(beforeRead);

    await sql`UPDATE opening_teaching_activities SET updated_at='2026-01-02T00:00:00Z'::timestamptz
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${f.courseId}`;
    const beforeTieRead = await persistedCourse(f.courseId);
    const expectedActivityId = [f.origin.activityId, second.activityId].sort().at(-1);
    const tied = await readLesson(lessonGet(f.courseId));
    expect(tied.status).toBe(200);
    expect(await tied.json()).toMatchObject({ session: { activityId: expectedActivityId } });
    expect(await persistedCourse(f.courseId)).toEqual(beforeTieRead);
  });

  it("keeps a learner-cancelled bound retest cancelled across ordinary reads, schedule replay and next", async () => {
    const fixture = currentFixture(), f = await start();
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
    const cancel = await updateTask(patchRequest(`/api/opening/tasks/${retest.taskId}`, {
      expectedVersion: Number(task!.version), status: "skipped", at: new Date().toISOString(),
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
    const fixture = currentFixture(), f = await start();
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
      clientKey: randomUUID(), answer: equationError(issued.spanExercise!), outcome: "unverified", assistance: "independent",
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
    const presentationBody = { activityId: next.activityId, repairVersion: 1, stage: "example", clientKey: `flow-presentation:${randomUUID()}` };
    const presented = await presentation(request(presentationPath, presentationBody));
    expect(presented.status, JSON.stringify(await presented.clone().json())).toBe(200);
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
    // A stale new-plan basis cannot re-release content, even with the old key. Read-only history
    // still retains the actual canonical example and its earlier exposure receipt.
    const oldHelp = await presentation(request(presentationPath, presentationBody));
    expect(oldHelp.status).toBe(409);
    expect(changed.attempts[0]?.spanExercise).toEqual(oldPresentation.problem);
    expect((await fixture.sql`SELECT delivered FROM opening_help_exposures WHERE id=${oldPresentation.exposureReceipt.id}`)[0]?.delivered).toBe(true);
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
    const fixture = currentFixture(), f = await start(fixture.otherScope);
    const response = await nextActivity(request(nextPath, {
      activityId: f.origin.activityId, expectedRevision: f.origin.revision, observationId: null, clientKey: randomUUID(),
    }));
    expect(response.status).toBe(404);
    expect(await f.lessons.get(fixture.otherScope, f.origin.activityId)).toEqual(f.origin);
    expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
    expect(await fixture.sql`SELECT id FROM opening_tasks WHERE course_id=${f.courseId}`).toHaveLength(0);
  });
});


it.each(["correct", "incorrect", "drift_wrong", "drift_correct"] as const)("authenticated normal confirm/start P error -> bounded B -> %s confirmation -> explicit T return", async outcome => {
  vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
  vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "0");
  const { sql, scope, cookie } = currentFixture(), rows = backupRows(sql, scope);
  // Only ordinary material/course prerequisites and test authorization are fixtures.
  // No SQL plan, binding, requirement, decision or observation is seeded.
  const sourceId = await rows.source("uploaded", 1), chunkId = await rows.chunk(sourceId, 1), courseId = randomUUID();
  await sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE id=${chunkId}`;
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'HTTP prerequisite journey',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  await createOpeningAdaptivePrefsRepository(sql).patch(scope, { spanTutorGrant: { courseId, enabled: true, dailyMinutes: 180, expiresOn: null, expectedRevision: 0 } });
  const json = async (response: Response, status = 200) => { expect(response.status, JSON.stringify(await response.clone().json())).toBe(status); return response.json(); };
  const goal = await json(await createGoal(request("/api/opening/learning-goals", { clientKey: randomUUID(), courseIds: [courseId], title: "独立完成原要求", kind: "custom",
    targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立解释并核对每一步" })));
  const p = randomUUID(), t = randomUUID(), context = { params: Promise.resolve({ id: courseId }) }, routePath = `/api/opening/courses/${courseId}/learning-route`;
  const prerequisite = { id: p, stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: SPAN_REQUIREMENT_KEY, title: "直接先修线性组合", position: 0,
    mandatory: true, goalIds: [goal.id], prerequisiteIds: [], sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }],
    verification: { kind: "exact", status: "missing", exerciseKeys: [], rubric: null, missingReasons: [] }, origin: "confirmed" };
  const target = { ...prerequisite, id: t, stableSkillId: randomUUID(), requirementKey: "requirement:target", title: "原课程要求", position: 1, prerequisiteIds: [p],
    verification: { kind: "rubric", status: "needs_check", exerciseKeys: [], rubric: "独立解释", missingReasons: [] } };
  const confirmed = await json(await confirmRoute(new Request(`http://localhost${routePath}`, { method: "PUT", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ expectedRevisions: [], requirements: [prerequisite, target], confirmScope: true,
      spanBindings: [{ requirementId: p, exerciseKeys: ["span-example-2d"], confirmContent: true }] }) }), context));
  expect(confirmed.requirements[0].requirement).toMatchObject({ id: p, requirementKey: SPAN_REQUIREMENT_KEY, verification: { kind: "exact", status: "ready" } });
  expect(confirmed.spanBindingOptions).toContainEqual(expect.objectContaining({ id: "span-example-2d", version: "1", dimension: 2 }));
  const startBody = (requirementId: string, clientKey = randomUUID()) => ({ goalId: goal.id, expectedGoalRevision: goal.revision,
    requirementId, expectedRequirementRevision: 1, minutes: 20, clientKey });
  const start = async (requirementId: string) => json(await startRoute(request(`${routePath}/start`, startBody(requirementId)), context));
  const own = await start(p); expect(own).toMatchObject({ kind: "ready", requirementId: p });
  const ownRead = await json(await readLesson(lessonGet(courseId, own.activity.id)));
  expect(ownRead.attempts).toHaveLength(1); const ownAttempt = ownRead.attempts[0];
  const submit = async (attempt: { id: string; spanExercise: SpanProblem }, correct: boolean, wrongEquation = false) => {
    const problem = attempt.spanExercise, solution = solveSpanProblem(problem); if (solution.kind !== "unique") throw new Error("requires unique finite fixture");
    return json(await submitAttempt(request(`/api/opening/attempts/${attempt.id}/submit`, { clientKey: randomUUID(),
      answer: JSON.stringify({ membership: "in_span", coefficients: correct ? solution.coefficients : ["0", "0"],
        equation: { vectors: wrongEquation ? [["999", "0"], ["0", "999"]] : problem.vectors, target: problem.target }, coordinateChecks: problem.target }),
      outcome: "unverified", assistance: "independent" }), { params: Promise.resolve({ id: attempt.id }) }), 201);
  };
  const originalWrong = await submit(ownAttempt, false, true);
  expect(originalWrong).toMatchObject({ outcome: "incorrect", verdictSource: "deterministic", serverEvaluation: { skills: { equation: "incorrect" } } });
  const targetRequest = startBody(t);
  const b = await json(await startRoute(request(`${routePath}/start`, targetRequest), context));
  expect(b).toMatchObject({ kind: "ready", action: "prerequisite", requirementId: p });
  expect(b.activity.id).not.toBe(own.activity.id);
  const chooser = vi.spyOn(spanDomain, "chooseSpanRepairTeaching");
  const read = async () => spanLessonDetailsSchema.parse(await json(await readLesson(lessonGet(courseId, b.activity.id))));
  let details = await read(), session = details.session!;
  expect(details.prerequisiteRepair).toMatchObject({ version: 1, returnToRequirementId: t, targetSkill: "equation" }); expect(details.attempts).toEqual([]);
  const beforeExampleGet = await persistedCourse(courseId); await read(); await read();
  expect(chooser).not.toHaveBeenCalled(); expect(await persistedCourse(courseId)).toEqual(beforeExampleGet);
  if (outcome.startsWith("drift")) {
    const newer = await json(await createAttempt(request("/api/opening/attempts", { sessionId: ownAttempt.sessionId, clientKey: randomUUID(),
      spanExercise: { sourceId, problemId: ownAttempt.spanExercise.id, version: 1 } })), 201);
    const observed = await submit(newer, outcome === "drift_correct", outcome === "drift_wrong");
    expect(observed.outcome).toBe(outcome === "drift_correct" ? "correct" : "incorrect");
    const before = await persistedCourse(courseId);
    const replay = await json(await startRoute(request(`${routePath}/start`, targetRequest), context), 409);
    expect(replay).toMatchObject({ error: { code: "CONFLICT" } });
    details = await read();
    expect(details.executionUnavailable?.reasonCode).toBe("SPAN_PREREQUISITE_EVIDENCE_CHANGED");
    expect(details.prerequisiteRepair).toBeUndefined();
    expect(details.session?.activityId).toBe(b.activity.id);
    const history = await json(await readRoute(new Request(`http://localhost${routePath}?activityId=${b.activity.id}`, { headers: { cookie } }), context));
    expect(history.currentActivity.id).toBe(b.activity.id);
    expect(await persistedCourse(courseId)).toEqual(before);
    expect(chooser).not.toHaveBeenCalled();
    const paused = await json(await saveLesson(patchRequest(`/api/opening/teaching/span/lesson?activityId=${session.activityId}`, {
      expectedRevision: session.revision, intent: session.intent, moveId: session.moveId, status: "paused" })));
    expect(paused.status).toBe("paused");
    const afterPause = await persistedCourse(courseId);
    details = await read();
    expect(details.session?.status).toBe("paused");
    expect(details.executionUnavailable?.reasonCode).toBe("SPAN_PREREQUISITE_EVIDENCE_CHANGED");
    expect(await persistedCourse(courseId)).toEqual(afterPause);
    return;
  }
  const move = async (moveId: string, status = 200) => {
    const response = await saveLesson(patchRequest(`/api/opening/teaching/span/lesson?activityId=${session.activityId}`, {
      expectedRevision: session.revision, intent: session.intent, moveId, status: "active" }));
    const result = await json(response, status); if (status === 200) session = result; return result;
  };
  await move("self-faded", 409);
  const shown = await json(await presentation(request("/api/opening/teaching/span/presentation", { activityId: session.activityId,
    prerequisiteRepairVersion: 1, stage: "example", clientKey: randomUUID() })));
  expect(shown.targetedExplanation).toMatchObject({ targetSkill: "equation" });
  const exampleState = await persistedCourse(courseId);
  expect(exampleState.help.find(row => row.id === shown.exposureReceipt.id)).toMatchObject({ delivered: true, level: "revealed" });
  details = await read(); expect(details.attempts).toHaveLength(1); expect(details.attempts[0]!.spanExercise).toEqual(shown.problem);
  expect(await persistedCourse(courseId)).toEqual(exampleState);
  await move("self-faded");
  const issue = async (stage: string, retryAfterAttemptId?: string, status = 200) => json(await issueRepair(request("/api/opening/teaching/span/reserved", {
    activityId: session.activityId, prerequisiteRepairVersion: 1, expectedRevision: session.revision, stage, clientKey: randomUUID(),
    ...(retryAfterAttemptId ? { retryAfterAttemptId } : {}) })), status);
  const beforeVariant = await persistedCourse(courseId); await read(); expect(await persistedCourse(courseId)).toEqual(beforeVariant);
  await issue("confirmation", undefined, 409);
  const variant = await issue("variant"); expect(await issue("variant")).toEqual(variant);
  expect(variant.spanExercise.id).not.toBe(shown.problem.id);
  expect((await read()).observations).toEqual([]);
  const wrong = await submit(variant, false);
  expect(wrong).toMatchObject({ outcome: "incorrect", assistance: "independent" });
  const hintResult = await json(await hint(request("/api/opening/teaching/span/hint", { attemptId: variant.id, level: 1 })));
  expect(hintResult).toMatchObject({ attemptId: variant.id, level: 1 });
  await move("self_study-reserved", 409);
  const retry = await issue("variant", variant.id); expect(retry.id).not.toBe(variant.id); expect(retry.itemVersionId).toBe(variant.itemVersionId);
  expect(await issue("variant", variant.id)).toEqual(retry);
  const exact = await submit(retry, true); expect(exact).toMatchObject({ outcome: "correct", assistance: "hinted", serverEvaluation: { coreEvidenceComplete: true } });
  const beforeRefresh = await persistedCourse(courseId); details = await read();
  expect(details.attempts.map(row => row.id)).toContain(retry.id); expect(details.observations).toContainEqual(expect.objectContaining({ id: wrong.id, answer: wrong.answer, assistance: wrong.assistance }));
  expect(details.hintLevels[variant.id]).toContain(1); expect(await persistedCourse(courseId)).toEqual(beforeRefresh);
  await move("self_study-reserved");
  const beforeValidation = await persistedCourse(courseId); await read(); expect(await persistedCourse(courseId)).toEqual(beforeValidation);
  const confirmation = await issue("confirmation"); expect(await issue("confirmation")).toEqual(confirmation);
  expect(confirmation.spanExercise.id).not.toBe(variant.spanExercise.id); expect(confirmation.spanExercise.familyId).toBe(variant.spanExercise.familyId);
  const observed = await submit(confirmation, outcome === "correct");
  expect(observed).toMatchObject({ outcome, assistance: "independent", verdictSource: "deterministic", serverEvaluation: { decision: outcome } });
  const beforeReturn = await persistedCourse(courseId); details = await read();
  expect(details.observations).toContainEqual(expect.objectContaining({ id: observed.id, outcome, answer: observed.answer }));
  expect(await persistedCourse(courseId)).toEqual(beforeReturn); expect(chooser).not.toHaveBeenCalled();
  const returnBody = { activityId: session.activityId, prerequisiteRepairVersion: 1, expectedRevision: session.revision, observationId: observed.id, clientKey: randomUUID() };
  const result = await json(await nextActivity(request(nextPath, returnBody)));
  expect(readSpanPrerequisiteReturnResult(result, courseId)).toEqual(result); expect(() => readSpanNextResult(result, courseId)).toThrow();
  expect(result).not.toHaveProperty("sessionId"); expect(result.href).toBe(`/opening/courses/${courseId}/study?activity=${result.activityId}`);
  const route = await json(await readRoute(new Request(`http://localhost${routePath}?activityId=${result.activityId}`, { headers: { cookie } }), context));
  expect(route.currentRoute).toMatchObject({ requirementId: t, action: "return" });
  const afterReturn = await persistedCourse(courseId), receipt = afterReturn.decisions.find(row => row.target_id === result.activityId)!;
  expect(receipt.receipt.reasonCodes).toContain("bounded_prerequisite_block_return"); expect(receipt.receipt.reasonCodes).not.toContain("verified_prerequisite_return");
  expect(afterReturn.attempts).toEqual(beforeReturn.attempts); expect(afterReturn.observations).toEqual(beforeReturn.observations); expect(afterReturn.help).toEqual(beforeReturn.help);
  expect(afterReturn.observations.find(row => row.id === originalWrong.id)).toMatchObject({ outcome: "incorrect", answer: originalWrong.answer });
  expect(await json(await nextActivity(request(nextPath, returnBody)))).toEqual({ ...result, resumed: true });
  await read(); expect(await persistedCourse(courseId)).toEqual(afterReturn);
});
