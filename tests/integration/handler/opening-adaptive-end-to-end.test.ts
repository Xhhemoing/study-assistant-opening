import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningAttempt, LearningObservation, PlanDraft, TeachingActivity } from "@aistudy/contracts";
import { createOpeningAdaptivePrefsRepository, createOpeningPlanningSettingsRepository, createOpeningPlansRepository, createOpeningTeachingActivitiesRepository } from "@aistudy/database";
import { ADAPTIVE_STRATEGY_VERSION, addLocalDays, localDateKeyInZone } from "@aistudy/domain";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import type { TodayPlanResult } from "../../../apps/web/src/features/opening/planning/plan-service";
import { POST as createAttempt } from "../../../apps/web/src/app/api/opening/attempts/route";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { GET as getToday } from "../../../apps/web/src/app/api/opening/today/route";
import { POST as acceptPlan } from "../../../apps/web/src/app/api/opening/plans/[id]/accept/route";
import { POST as createActivity } from "../../../apps/web/src/app/api/opening/teaching-activities/route";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { matrixAttemptFixture, matrixRequirement, matrixSkill } from "../opening-matrix-attempt-fixture";

let fixture: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
let day: string;

beforeEach(async () => {
  vi.stubEnv("OPENING_ADAPTIVE_PLANNING", "1");
  vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "0");
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({
    databaseUrl: process.env.DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    authCookieName: "aistudy_session", sessionCookieSecure: false, sessionTtlSeconds: 3600,
  });
  setAuthRuntimeForTests(runtime);
  // Keep real authentication/evidence clocks, and plan tomorrow so acceptance cannot expire during CI.
  const timeZone = "Etc/UTC";
  day = addLocalDays(localDateKeyInZone(new Date(), timeZone), 1);
  const weekday = new Date(`${day}T12:00:00.000Z`).getUTCDay();
  await createOpeningPlanningSettingsRepository(fixture.sql).set(fixture.scope, {
    weekOneMonday: addLocalDays(day, -((weekday + 6) % 7)),
    periodTimes: { "1": { start: "08:00", end: "08:45" } },
    dailyWindow: { start: "08:00", end: "12:00" },
    lunch: { start: "12:00", end: "13:00" }, dinner: { start: "17:30", end: "18:30" },
    sleep: { start: "23:00", end: "07:00" }, timeZone,
  });
  await createOpeningAdaptivePrefsRepository(fixture.sql).patch(fixture.scope, { autonomy: "copilot" });
});

afterEach(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await fixture?.close();
  vi.unstubAllEnvs();
});

function request(path: string, body?: unknown) {
  return new Request(`http://localhost/api/opening${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: fixture.cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });

async function recordVerifiedError() {
  const course = await matrixAttemptFixture(fixture);
  await fixture.sql`INSERT INTO course_asset_memberships
    (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility)
    VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${course.courseId}, 'source', ${course.sourceId}, 'core', 0, 'course')`;
  const started = await createAttempt(request("/attempts", {
    sessionId: course.sessionId, clientKey: randomUUID(),
    matrixExercise: { sourceId: course.sourceId, exerciseKey: "dimensions", variant: 0 },
  }));
  expect(started.status).toBe(201);
  const attempt = await started.json() as LearningAttempt;
  const submitted = await submitAttempt(request(`/attempts/${attempt.id}/submit`, {
    clientKey: randomUUID(), answer: "[3,2]", outcome: "correct", assistance: "independent", verdictSource: "self_report",
  }), context(attempt.id));
  expect(submitted.status).toBe(201);
  const observation = await submitted.json() as LearningObservation;
  expect(observation).toMatchObject({
    attemptId: attempt.id, courseId: course.courseId, skillLabel: matrixSkill,
    outcome: "incorrect", verdictSource: "deterministic", requirementKey: matrixRequirement,
    eligibility: { verifiedCorrect: "no", independentAttempt: "yes" },
  });
  return { ...course, observation };
}

it("carries a verified error through Today selection into a server-derived targeted teaching focus", async () => {
  const chosen = await recordVerifiedError();
  const unchosen = await recordVerifiedError();
  const repo = createOpeningPlansRepository(fixture.sql);
  const todayResponse = await getToday(request(`/today?date=${day}`));
  expect(todayResponse.status).toBe(200);
  const today = await todayResponse.json() as TodayPlanResult;
  const draft = today.dailyDraft!;
  expect(draft.strategyVersion).toBe(ADAPTIVE_STRATEGY_VERSION);
  expect(draft.suggestedTasks).toHaveLength(2);
  const selected = draft.suggestedTasks!.find((item) => item.courseId === chosen.courseId)!;
  const other = draft.suggestedTasks!.find((item) => item.courseId === unchosen.courseId)!;
  expect(selected).toMatchObject({ kind: "weak_skill", skillLabel: matrixSkill });
  expect(draft.blocks.map((block) => block.taskId)).toEqual(expect.arrayContaining([selected.id, other.id]));
  expect(await repo.listTasks(fixture.scope)).toEqual([]);

  const acceptBody = { expectedBaseVersion: draft.baseVersion, clientKey: randomUUID(), acceptSuggestedKeys: [selected.key] };
  const acceptedResponse = await acceptPlan(request(`/plans/${draft.id}/accept`, acceptBody), context(draft.id));
  expect(acceptedResponse.status).toBe(200);
  const accepted = await acceptedResponse.json() as PlanDraft;
  expect(accepted).toMatchObject({ id: draft.id, status: "accepted" });
  expect(accepted.blocks.map((block) => block.taskId)).toEqual([selected.id]);
  expect(await repo.listTasks(fixture.scope)).toEqual([
    expect.objectContaining({ id: selected.id, courseId: chosen.courseId, skillLabel: matrixSkill, status: "pending", origin: "planner" }),
  ]);
  const replay = await acceptPlan(request(`/plans/${draft.id}/accept`, acceptBody), context(draft.id));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ id: draft.id, version: accepted.version });
  const mismatched = await acceptPlan(request(`/plans/${draft.id}/accept`, { ...acceptBody, acceptSuggestedKeys: [] }), context(draft.id));
  expect(mismatched.status).toBe(409);
  expect(await mismatched.json()).toMatchObject({ error: { code: "CONFLICT", reason: "selection_mismatch" } });
  expect(await repo.listTasks(fixture.scope)).toHaveLength(1);

  const activityBody = {
    clientKey: `task:${selected.id}`, intentKind: "goal", intentSummary: "Client supplied wrong course and skill",
    courseId: unchosen.courseId, sourceIds: [unchosen.sourceId],
    createIntent: { intentKind: "goal", source: "task", taskId: selected.id, skillLabel: "forged-skill" },
    goalJson: { learnerFocus: {
      skillLabel: "forged-skill", activityKind: "transfer_check", reasonCode: "independent",
      focusObservationId: unchosen.observation.id, recentAssistance: [], strategyVersion: "client-forged",
    } },
    continueAfterCompleted: true,
  };
  const activityResponse = await createActivity(request("/teaching-activities", activityBody));
  expect(activityResponse.status).toBe(201);
  const activity = await activityResponse.json() as TeachingActivity;
  expect(activity).toMatchObject({ courseId: chosen.courseId, intentSummary: selected.title, sourceIds: [chosen.sourceId] });
  expect(activity.learnerFocus).toMatchObject({ skillLabel: matrixSkill, activityKind: "targeted_explain", focusObservationId: chosen.observation.id });
  const rows = await fixture.sql`SELECT course_id, source_ids, goal_json FROM opening_teaching_activities
    WHERE id=${activity.id} AND workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({
    course_id: chosen.courseId, source_ids: [chosen.sourceId],
    goal_json: { learnerFocus: {
      skillLabel: matrixSkill, requirementKey: matrixRequirement, activityKind: "targeted_explain", reasonCode: "verified_incorrect",
      focusObservationId: chosen.observation.id, recentAssistance: ["independent"], recentErrors: [], strategyVersion: ADAPTIVE_STRATEGY_VERSION,
      goalContext: { mode: "understand", targetDate: null, daysRemaining: null, priority: 0, prerequisiteBudgetMinutes: 10, reasonCode: "long_term" },
    } },
  });
  const activityReplay = await createActivity(request("/teaching-activities", activityBody));
  expect(activityReplay.status).toBe(201);
  expect(await activityReplay.json()).toMatchObject({ id: activity.id });
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE workspace_id=${fixture.scope.workspaceId}
    AND kind='compile-teaching-unit' AND payload->>'activityId'=${activity.id}`).toHaveLength(0);
  const reassociated = await createOpeningTeachingActivitiesRepository(fixture.sql).associateCourse(fixture.scope, activity.id, { courseId: unchosen.courseId });
  expect(reassociated).not.toHaveProperty("learnerFocus");
});
