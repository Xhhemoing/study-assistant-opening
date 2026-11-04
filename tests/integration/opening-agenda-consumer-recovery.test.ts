import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { DEFAULT_OPENING_ADAPTIVE_PREFS, type LearningAgenda } from "@aistudy/contracts";
import {
  createSqlClient, createOpeningLearningAttemptRepository, createOpeningLearningRepository,
  createOpeningLongTermPlanningRepository, createOpeningSpanTutorContextRepository,
  createWorkspacePreferencesRepository, type OpeningScope,
} from "@aistudy/database";
import { nextLearningStep, solveSpanProblem, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import type { Sql } from "postgres";
import { createSpanHintService } from "../../apps/web/src/features/opening/teaching/span/hint-service";
import { createSpanLessonSessionService } from "../../apps/web/src/features/opening/teaching/span/lesson-session-service";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture } from "./opening-fixture";

let sql: Sql;
let scope: OpeningScope;
beforeEach(async () => {
  const fixture = await createOpeningFixture();
  sql = fixture.sql;
  scope = fixture.scope;
});
afterEach(async () => { await sql?.end({ timeout: 5 }); });

// End the original pool, not fixture.reset(): the new readers only have durable IDs.
async function reconnect() {
  await sql.end({ timeout: 5 });
  const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB);
  sql = createSqlClient(url.toString());
}

async function seed() {
  const rows = backupRows(sql, scope), courseId = randomUUID(), sourceId = await rows.source();
  await rows.chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${scope.workspaceId},'Consumer recovery',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope, {
    assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false,
  });
  const at = new Date().toISOString();
  const grant = { enabled: true, dailyMinutes: 180, revision: 1, confirmedAt: at, updatedAt: at, expiresOn: null };
  await sql`UPDATE workspace_preferences SET adaptive_planning=jsonb_set(
    COALESCE(adaptive_planning,${sql.json(DEFAULT_OPENING_ADAPTIVE_PREFS)}::jsonb),'{spanTutorGrants}',
    COALESCE(adaptive_planning->'spanTutorGrants','{}'::jsonb) || ${sql.json({ [courseId]: grant })}::jsonb)
    WHERE workspace_id=${scope.workspaceId}`;
  const repo = createOpeningSpanTutorContextRepository(sql);
  const context = await repo.read(scope, { courseId, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 }, question: "继续学习" });
  if (!context) throw new Error("Expected authorized tutor context");
  const lesson = await repo.execute(scope, { context, decision: nextLearningStep(context.decisionInput), operationId: randomUUID() });
  return { courseId, sourceId, activityId: lesson.activityId, sessionId: lesson.sessionId };
}
type Ids = Awaited<ReturnType<typeof seed>>;

async function submit(ids: Ids, kind: "hinted_error" | "unknown_correct" | "independent_correct") {
  const attempt = await createOpeningLearningAttemptRepository(sql).create(scope, {
    sessionId: ids.sessionId, clientKey: randomUUID(),
    spanExercise: { sourceId: ids.sourceId, problemId: kind === "hinted_error" ? "span-example-2d" : "span-reserved-fraction", version: 1 },
  });
  if (kind === "hinted_error") {
    expect((await createSpanHintService(sql).read(scope, { attemptId: attempt.id, level: 1 })).exposureReceipt).toBeTruthy();
  }
  let answer: unknown = { membership: "in_span", coefficients: ["999", "999"] };
  if (kind !== "hinted_error") {
    if (!attempt.spanExercise) throw new Error("Expected persisted span problem");
    const solution = solveSpanProblem(attempt.spanExercise);
    if (solution.kind !== "unique") throw new Error("Expected unique reserved problem");
    answer = { membership: "in_span", coefficients: solution.coefficients,
      equation: { vectors: attempt.spanExercise.vectors, target: attempt.spanExercise.target }, coordinateChecks: attempt.spanExercise.target };
  }
  const observation = await createOpeningLearningRepository(sql).insertObservation(scope, {
    sessionId: ids.sessionId, courseId: ids.courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [ids.sourceId],
    attemptId: attempt.id, problemId: attempt.problemId, clientKey: randomUUID(), answer: JSON.stringify(answer),
    outcome: "unverified", assistance: kind === "unknown_correct" ? "unknown" : "independent", verdictSource: "self_report",
  });
  expect(observation).toMatchObject({ outcome: kind === "hinted_error" ? "incorrect" : "correct",
    serverEvaluation: { evaluatorVersion: "span-exact-v1" } });
  if (kind === "unknown_correct") expect(observation.assistance).toBe("unknown");
  return { observationId: observation.id, attemptId: attempt.id, itemVersionId: attempt.itemVersionId };
}

async function persisted() {
  // Full rows catch content changes as well as new entities, including both budget stores.
  const w = scope.workspaceId;
  return {
    activities: await sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${w} ORDER BY id`,
    sessions: await sql`SELECT * FROM opening_learning_sessions WHERE workspace_id=${w} ORDER BY id`,
    attempts: await sql`SELECT * FROM opening_learning_attempts WHERE workspace_id=${w} ORDER BY id`,
    observations: await sql`SELECT * FROM opening_learning_observations WHERE workspace_id=${w} ORDER BY id`,
    help: await sql`SELECT * FROM opening_help_exposures WHERE workspace_id=${w} ORDER BY id`,
    decisions: await sql`SELECT * FROM opening_learning_decisions WHERE workspace_id=${w} ORDER BY id`,
    retests: await sql`SELECT * FROM opening_retest_activities WHERE workspace_id=${w} ORDER BY id`,
    tasks: await sql`SELECT * FROM opening_tasks WHERE workspace_id=${w} ORDER BY id`,
    budgets: await sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${w} ORDER BY id`,
    preferences: await sql`SELECT * FROM workspace_preferences WHERE workspace_id=${w}`,
  };
}

async function readConsumers(ids: Ids, retestId?: string) {
  const lesson = await createSpanLessonSessionService(sql).read(scope, ids.courseId, ids.activityId, retestId);
  const today = await createOpeningLongTermPlanningRepository(sql).read(scope);
  expect(lesson.session).toMatchObject({ activityId: ids.activityId, sessionId: ids.sessionId, courseId: ids.courseId });
  expect(today.recovery.activityId).toBe(ids.activityId);
  if (!("agenda" in lesson) || !lesson.agenda) throw new Error("Expected persisted lesson agenda");
  expect(today.recovery.agenda).toBeTruthy();
  return { lesson, today, agendas: [lesson.agenda!, today.recovery.agenda!] };
}

function expectIdentity(agenda: LearningAgenda, ids: Ids, original: LearningAgenda, itemVersionId: string | null) {
  expect(agenda).toMatchObject({ activityId: ids.activityId, sessionId: ids.sessionId, courseId: ids.courseId,
    itemVersionId, decisionId: original.decisionId, parentDecisionId: original.parentDecisionId, budget: original.budget });
  expect(agenda.decisionId).toBeTruthy();
  expect(agenda.parentDecisionId).toBeTruthy();
  expect(agenda.budget).toBeTruthy();
}

async function continueOriginal(ids: Ids, today: Awaited<ReturnType<typeof readConsumers>>["today"]) {
  return createOpeningLongTermPlanningRepository(sql).recover(scope, {
    action: "continue", activityId: ids.activityId, taskId: null, date: today.date,
    expectedAcceptedVersion: today.acceptedVersion, expectedBudgetRevision: today.budget?.revision ?? 0, clientKey: randomUUID(),
  });
}

it("recovers repeated hinted errors through new course/today readers without writes, then clears escalation after independent success", async () => {
  const ids = await seed();
  await submit(ids, "hinted_error");
  const latest = await submit(ids, "hinted_error");
  const original = (await readConsumers(ids)).agendas[0]!;
  expect(original.suggestion).toMatchObject({ activityKind: "full_explain", reasonCode: "repeated_assisted_error", focusObservationId: latest.observationId });
  const before = await persisted();
  expect(before.activities).toHaveLength(1);
  expect(before.help).toHaveLength(2);
  await reconnect();
  for (let read = 0; read < 2; read++) {
    const recovered = await readConsumers(ids);
    for (const agenda of recovered.agendas) {
      expectIdentity(agenda, ids, original, latest.itemVersionId);
      expect(agenda).toMatchObject({ resumable: true, status: "active", decisionCurrent: false,
        help: { delivered: true, level: "hinted" }, suggestion: { activityKind: "full_explain",
          reasonCode: "repeated_assisted_error", focusObservationId: latest.observationId } });
    }
    expect(recovered.lesson.attempts.map(row => row.id)).toContain(latest.attemptId);
    expect(recovered.lesson.observations.find(row => row.id === latest.observationId)).toMatchObject({ outcome: "incorrect", attemptId: latest.attemptId });
    expect(recovered.lesson.assistance[latest.attemptId]).toBe("hinted");
    expect(await continueOriginal(ids, recovered.today)).toMatchObject({ activityId: ids.activityId,
      href: `/opening/courses/${ids.courseId}/study/span?lesson=${ids.activityId}` });
    expect(await persisted()).toEqual(before);
  }
  const success = await submit(ids, "independent_correct");
  const afterSuccess = await persisted();
  await reconnect();
  for (const agenda of (await readConsumers(ids)).agendas) {
    expectIdentity(agenda, ids, original, success.itemVersionId);
    expect(agenda).toMatchObject({ resumable: true,
      suggestion: { activityKind: "reduced_help_practice", reasonCode: "assistance_dependent" } });
  }
  expect(await persisted()).toEqual(afterSuccess);
});

it("preserves genuinely unknown assistance and its independent-check suggestion after pool replacement", async () => {
  const ids = await seed(), submitted = await submit(ids, "unknown_correct");
  const original = (await readConsumers(ids)).agendas[0]!;
  const before = await persisted();
  expect(before.help).toHaveLength(0);
  await reconnect();
  for (let read = 0; read < 2; read++) {
    const recovered = await readConsumers(ids);
    for (const agenda of recovered.agendas) {
      expectIdentity(agenda, ids, original, submitted.itemVersionId);
      expect(agenda).toMatchObject({ status: "active", resumable: true, help: { delivered: false, level: "none" },
        suggestion: { activityKind: "transfer_check", reasonCode: "correct_needs_independent_check" } });
    }
    expect(recovered.lesson.observations.find(row => row.id === submitted.observationId))
      .toMatchObject({ assistance: "unknown", outcome: "correct", attemptId: submitted.attemptId });
    expect(recovered.lesson.assistance[submitted.attemptId]).toBe("none");
    expect(await continueOriginal(ids, recovered.today)).toMatchObject({ activityId: ids.activityId });
    expect(await persisted()).toEqual(before);
  }
});

it.each(["cancelled", "deferred"] as const)("does not revive a %s retest in either rebuilt consumer or recover continue", async status => {
  const ids = await seed();
  await submit(ids, "hinted_error");
  const latest = await submit(ids, "hinted_error"), retestId = randomUUID();
  // Existing persisted-retest fixture shape; teaching activity stays active to exercise agenda gating.
  await sql`INSERT INTO opening_retest_activities
    (id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version,snoozed_until)
    VALUES (${retestId},${scope.workspaceId},${scope.ownerUserId},${ids.courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},
      ${randomUUID()},${status === "cancelled" ? "cancelled" : "accepted"},2,${status === "deferred" ? new Date(Date.now() + 86400000) : null})`;
  await sql`UPDATE opening_teaching_activities SET checkpoint_json=jsonb_set(checkpoint_json,'{spanLesson,retestId}',${sql.json(retestId)}::jsonb)
    WHERE id=${ids.activityId}`;
  const original = (await readConsumers(ids, retestId)).agendas[0]!;
  const before = await persisted();
  expect(before.activities).toHaveLength(1);
  expect(before.retests).toHaveLength(1);
  await reconnect();
  for (let read = 0; read < 2; read++) {
    const recovered = await readConsumers(ids, retestId);
    for (const agenda of recovered.agendas) {
      expectIdentity(agenda, ids, original, latest.itemVersionId);
      expect(agenda).toMatchObject({ status, resumable: false, pendingRetestId: retestId,
        invalidationReasons: expect.arrayContaining([status === "cancelled" ? "retest_cancelled_or_unavailable" : "retest_deferred"]),
        suggestion: { activityKind: "full_explain", reasonCode: "repeated_assisted_error", focusObservationId: latest.observationId } });
    }
    await expect(continueOriginal(ids, recovered.today)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await persisted()).toEqual(before);
  }
});
