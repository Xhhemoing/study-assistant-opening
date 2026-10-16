/**
 * Portable, non-browser A/B evaluation. Copy unchanged into both revisions as
 * tests/integration/adaptive-ab-comparison.test.ts and run the integration project.
 * This is a purposive functional challenge set, not an estimate of student benefit.
 * Each record owns a fresh fixture; failures do not cancel subsequent records.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import type { OpeningPlanningSettings, TeachingLearnerFocus } from "@aistudy/contracts";
import {
  createOpeningAdaptivePrefsRepository,
  createOpeningPlanningSettingsRepository,
  createOpeningPlansRepository,
  readOpeningTeachingCompilerFocus,
  readOpeningTeachingTaskFocus,
} from "@aistudy/database";
import { ADAPTIVE_STRATEGY_VERSION } from "@aistudy/domain";
import { createOpeningPlanService } from "../../apps/web/src/features/opening/planning/plan-service";
import { createSqlLearnerSnapshotService } from "../../apps/web/src/features/opening/planning/learner-snapshot-runtime";
import { createOpeningTeachingActivityService } from "../../apps/web/src/features/opening/teaching/activity-service";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { readOpeningCourseObservationHeads } from "../../packages/database/src/repositories/opening-learning-read";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

const day = "2026-10-21";
const timeZone = "Asia/Shanghai";
const now = new Date(`${day}T00:00:00.000Z`);
const settings: OpeningPlanningSettings = {
  weekOneMonday: "2026-10-19",
  periodTimes: { "1": { start: "08:00", end: "08:45" } },
  dailyWindow: { start: "08:00", end: "12:00" },
  lunch: { start: "12:00", end: "13:00" },
  dinner: { start: "17:30", end: "18:30" },
  sleep: { start: "23:00", end: "07:00" },
  timeZone,
};

type JsonObject = Record<string, unknown>;
type Result = {
  id: string; title: string; group: "challenge" | "control";
  expected: unknown; actual: unknown; pass: boolean; status: "pass" | "fail" | "error";
  durationMs: number; error?: string;
};
const results: Result[] = [];
const asObject = (value: unknown): JsonObject => value !== null && typeof value === "object" ? value as JsonObject : {};
const field = (value: unknown, key: string): unknown => asObject(value)[key] ?? null;

/** Timing includes fixture creation/seeding/cleanup; it is not request latency. */
async function record(
  id: string,
  title: string,
  group: Result["group"],
  expected: unknown,
  run: (fixture: OpeningFixture) => Promise<unknown>,
) {
  const started = performance.now();
  let fixture: OpeningFixture | undefined;
  let actual: unknown = null;
  let error: string | undefined;
  try {
    fixture = await createOpeningFixture();
    await createOpeningPlanningSettingsRepository(fixture.sql).set(fixture.scope, settings);
    await createOpeningAdaptivePrefsRepository(fixture.sql).patch(fixture.scope, { autonomy: "copilot" });
    actual = await run(fixture);
  } catch (cause) {
    error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  } finally {
    try { await fixture?.close(); } catch (cause) {
      error = `${error ? `${error}; ` : ""}cleanup: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  const pass = error === undefined && isDeepStrictEqual(actual, expected);
  results.push({
    id, title, group, expected, actual, pass, status: error ? "error" : pass ? "pass" : "fail",
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    ...(error ? { error } : {}),
  });
}

async function seedCourse(fixture: OpeningFixture) {
  const course = await learningAttemptFixture(fixture);
  await fixture.sql`INSERT INTO course_asset_memberships
    (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility)
    VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${course.courseId}, 'source', ${course.sourceId}, 'core', 0, 'course')`;
  return course;
}
type Course = Awaited<ReturnType<typeof seedCourse>>;
const reference = (course: Course) => ({
  verdictSource: "reference_checked", referenceSourceId: course.sourceId,
  referenceCheck: { referenceSourceId: course.sourceId, method: "Compared against the reference solution", scope: "whole_answer" },
});
async function wrongAnswer(course: Course, requirementKey = "R2") {
  return course.submit(await course.start({ requirementKey }), {
    ...reference(course), answer: "2", outcome: "incorrect",
  });
}

/** Explicit timestamps make the ordering independent of database clock precision. */
async function sameLabelRequirements(fixture: OpeningFixture) {
  const course = await seedCourse(fixture);
  const wrong = await wrongAnswer(course, "R2");
  const correct = await course.submit(await course.start({ requirementKey: "R1" }), reference(course));
  await fixture.sql`UPDATE opening_learning_observations
    SET started_at='2026-10-16T07:59:00Z',submitted_at='2026-10-16T08:00:00Z',occurred_at='2026-10-16T08:00:00Z' WHERE id=${wrong.id}`;
  await fixture.sql`UPDATE opening_learning_observations
    SET started_at='2026-10-16T08:00:30Z',submitted_at='2026-10-16T08:01:00Z',occurred_at='2026-10-16T08:01:00Z' WHERE id=${correct.id}`;
  return { course, wrong, correct };
}

function services(fixture: OpeningFixture) {
  const snapshots = createSqlLearnerSnapshotService(fixture.sql, { now: () => now });
  const plans = createOpeningPlanService(fixture.sql, {
    now: () => now, adaptive: { enabled: () => true, readSnapshot: snapshots.read },
  });
  // Compilation stays off: no provider, LLM, HTTP request, or worker is invoked.
  const activities = createOpeningTeachingActivityService(fixture.sql, { OPENING_ADAPTIVE_PLANNING: "1" });
  return { snapshots, plans, activities };
}

async function acceptSingleRequirement(fixture: OpeningFixture) {
  const course = await seedCourse(fixture);
  const wrong = await wrongAnswer(course);
  const runtime = services(fixture);
  const draft = (await runtime.plans.getToday(fixture.scope, day)).dailyDraft;
  const suggestion = draft?.suggestedTasks?.find(row => row.kind === "weak_skill" && row.courseId === course.courseId);
  if (!draft || !suggestion) throw new Error("Precondition: a sole current verified error must yield a weak-skill draft suggestion");
  const acceptance = {
    draftId: draft.id, expectedBaseVersion: draft.baseVersion,
    clientKey: randomUUID(), acceptSuggestedKeys: [suggestion.key],
  };
  const accepted = await runtime.plans.acceptPlan(fixture.scope, acceptance);
  return { ...runtime, course, wrong, draft, suggestion, accepted, acceptance };
}

/** Baseline lacks migration 0065. Observing absence is valid; changing schema is not. */
async function storedRequirement(fixture: OpeningFixture, taskId: string) {
  const columns = await fixture.sql`SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='opening_tasks' AND column_name='requirement_key'`;
  if (columns.length === 0) return null;
  const [row] = await fixture.sql`SELECT requirement_key FROM opening_tasks WHERE id=${taskId}
    AND workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}`;
  return row?.requirement_key ?? null;
}

async function storeFocus(
  fixture: OpeningFixture,
  course: Course,
  observationId: string | null,
  activityKind: TeachingLearnerFocus["activityKind"] = "targeted_explain",
  requirementKey = "R2",
) {
  // The extra requirement field is deliberate forward-compatible fixture data.
  const learnerFocus = {
    skillLabel: "fractions", requirementKey, activityKind,
    reasonCode: activityKind === "targeted_explain" ? "verified_error" : activityKind === "transfer_check" ? "independent" : "assistance_dependent",
    focusObservationId: observationId,
    recentAssistance: [activityKind === "reduced_help_practice" ? "hinted" : "independent"],
    strategyVersion: ADAPTIVE_STRATEGY_VERSION,
  };
  const [activity] = await fixture.sql`UPDATE opening_teaching_activities SET goal_json=${fixture.sql.json({ learnerFocus })}
    WHERE id=(SELECT activity_id FROM opening_learning_sessions WHERE id=${course.sessionId})
      AND workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}
    RETURNING id`;
  if (!activity) throw new Error("Precondition: the seeded learning session has an owning teaching activity");
  return String(activity.id);
}

it("records every portable real-SQL A/B scenario without stopping on behavioral differences", async () => {
  results.length = 0;
  await record("SQL01", "same-label evidence preserves two requirement states", "challenge", {
    targetCount: 2,
    states: [{ requirementKey: "R1", status: "observed_independent" }, { requirementKey: "R2", status: "needs_review" }],
  }, async fixture => {
    const { course } = await sameLabelRequirements(fixture);
    const read = await services(fixture).snapshots.read(fixture.scope, { date: day, timeZone });
    const skills = read.snapshot.courses.find(row => row.courseId === course.courseId)?.skills ?? [];
    return { targetCount: skills.length, states: skills.map(row => ({ requirementKey: field(row, "requirementKey"), status: row.status }))
      .sort((a, b) => String(a.requirementKey).localeCompare(String(b.requirementKey))) };
  });

  await record("SQL02", "later R1 success cannot hide the R2 error from planning", "challenge", {
    weakSuggestions: [{ requirementKey: "R2", skillLabel: "fractions" }], tasksCreatedByPreview: 0,
  }, async fixture => {
    const { course } = await sameLabelRequirements(fixture);
    const draft = (await services(fixture).plans.getToday(fixture.scope, day)).dailyDraft;
    return {
      weakSuggestions: (draft?.suggestedTasks ?? []).filter(row => row.kind === "weak_skill" && row.courseId === course.courseId)
        .map(row => ({ requirementKey: field(row, "requirementKey"), skillLabel: row.skillLabel })),
      tasksCreatedByPreview: (await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).length,
    };
  });

  await record("SQL03", "acceptance retains the requested requirement in SQL and task projection", "challenge", {
    accepted: true, storedRequirement: "R2", projectedRequirement: "R2", taskCount: 1,
  }, async fixture => {
    const { accepted, suggestion } = await acceptSingleRequirement(fixture);
    const tasks = await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope);
    return { accepted: accepted.status === "accepted", storedRequirement: await storedRequirement(fixture, suggestion.id),
      projectedRequirement: field(tasks.find(row => row.id === suggestion.id), "requirementKey"), taskCount: tasks.length };
  });

  await record("SQL04", "task-owned teaching focus survives a forged client requirement", "challenge", {
    requirementKey: "R2", activityKind: "targeted_explain", referencesOwnedError: true, courseMatches: true,
  }, async fixture => {
    const { course, wrong, suggestion, activities } = await acceptSingleRequirement(fixture);
    const activity = await activities.create(fixture.scope, {
      clientKey: `ab-teaching-${randomUUID()}`, intentKind: "topic", intentSummary: "Continue the accepted task",
      createIntent: { taskId: suggestion.id },
      goalJson: { learnerFocus: { requirementKey: "R1", focusObservationId: randomUUID() } },
    });
    const [stored] = await fixture.sql`SELECT course_id,goal_json FROM opening_teaching_activities
      WHERE id=${activity.id} AND workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}`;
    const focus = asObject(asObject(stored?.goal_json).learnerFocus);
    return { requirementKey: field(focus, "requirementKey"), activityKind: field(focus, "activityKind"),
      referencesOwnedError: focus.focusObservationId === wrong.id, courseMatches: stored?.course_id === course.courseId };
  });

  await record("SQL05", "backup exports the accepted task requirement", "challenge", {
    foundAcceptedTask: true, requirementKey: "R2",
  }, async fixture => {
    const { suggestion } = await acceptSingleRequirement(fixture);
    const backup = await readOpeningBackupRecords(fixture.sql, fixture.scope);
    const row = backup.tables.opening_tasks.find(row => row.id === suggestion.id);
    return { foundAcceptedTask: Boolean(row), requirementKey: field(row, "requirement_key") };
  });

  await record("SQL06", "source upgrade preserves historical wrong answer without current remedial scheduling", "challenge", {
    currentMaterialUsable: true, historicalAnswerRetained: true, historicalCorrectnessRetained: true,
    historicalCurrentlyUsable: false, weakSuggestionCount: 0, taskCount: 0,
  }, async fixture => {
    const course = await seedCourse(fixture);
    const wrong = await wrongAnswer(course);
    await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${course.sourceId}`;
    await backupRows(fixture.sql, fixture.scope).chunk(course.sourceId, 2);
    const runtime = services(fixture);
    const read = await runtime.snapshots.read(fixture.scope, { date: day, timeZone });
    const history = await readOpeningCourseObservationHeads(fixture.sql, fixture.scope, course.courseId);
    const observation = history.find(row => row.id === wrong.id);
    const draft = (await runtime.plans.getToday(fixture.scope, day)).dailyDraft;
    return {
      currentMaterialUsable: read.snapshot.courses.find(row => row.courseId === course.courseId)?.hasUsableMaterials === true,
      historicalAnswerRetained: observation?.answer === "2",
      historicalCorrectnessRetained: observation?.eligibility?.verifiedCorrect === "no",
      historicalCurrentlyUsable: observation?.eligibility?.usableForCurrentVersion === "yes",
      weakSuggestionCount: (draft?.suggestedTasks ?? []).filter(row => row.kind === "weak_skill" && row.courseId === course.courseId).length,
      taskCount: (await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).length,
    };
  });

  await record("SQL07", "current owned verified error remains available to compilation", "control", {
    hasLearnerFocus: true, question: "1/2 + 1/2?", answer: "2",
  }, async fixture => {
    const course = await seedCourse(fixture);
    const wrong = await wrongAnswer(course);
    const activityId = await storeFocus(fixture, course, wrong.id);
    const compiled = await readOpeningTeachingCompilerFocus(fixture.sql, fixture.scope, activityId);
    return { hasLearnerFocus: Boolean(compiled.learnerFocus), question: compiled.focusAttempt?.question ?? null,
      answer: compiled.focusAttempt?.answer ?? null };
  });

  await record("SQL08", "compiler denies another workspace and a wrong owner in the same workspace", "control", {
    otherWorkspaceEmpty: true, wrongOwnerEmpty: true,
  }, async fixture => {
    const course = await seedCourse(fixture);
    const wrong = await wrongAnswer(course);
    const activityId = await storeFocus(fixture, course, wrong.id);
    const other = await readOpeningTeachingCompilerFocus(fixture.sql, fixture.otherScope, activityId);
    const wrongOwner = await readOpeningTeachingCompilerFocus(fixture.sql, {
      workspaceId: fixture.scope.workspaceId, ownerUserId: fixture.otherScope.ownerUserId,
    }, activityId);
    return { otherWorkspaceEmpty: Object.keys(other).length === 0, wrongOwnerEmpty: Object.keys(wrongOwner).length === 0 };
  });

  for (const [caseId, activityKind] of [["SQL09", "transfer_check"], ["SQL10", "reduced_help_practice"]] as const) {
    await record(caseId, `${activityKind} without a focus observation expires after a source upgrade`, "challenge", {
      availableBefore: true, unavailableAfter: true,
    }, async fixture => {
      const course = await seedCourse(fixture);
      const attempt = await course.start({ requirementKey: "R1" });
      if (activityKind === "reduced_help_practice") await course.help(attempt);
      await course.submit(attempt, { ...reference(course), assistance: activityKind === "reduced_help_practice" ? "hinted" : "independent" });
      const activityId = await storeFocus(fixture, course, null, activityKind, "R1");
      const before = await readOpeningTeachingCompilerFocus(fixture.sql, fixture.scope, activityId);
      await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${course.sourceId}`;
      await backupRows(fixture.sql, fixture.scope).chunk(course.sourceId, 2);
      const after = await readOpeningTeachingCompilerFocus(fixture.sql, fixture.scope, activityId);
      return { availableBefore: Boolean(before.learnerFocus), unavailableAfter: Object.keys(after).length === 0 };
    });
  }

  await record("SQL11", "accepted task cannot be read or used to create another owner's activity", "control", {
    otherTaskNull: true, wrongOwnerTaskNull: true, activityErrorCode: "NOT_FOUND",
  }, async fixture => {
    const { suggestion, activities } = await acceptSingleRequirement(fixture);
    const other = await readOpeningTeachingTaskFocus(fixture.sql, fixture.otherScope, suggestion.id);
    const wrongOwner = await readOpeningTeachingTaskFocus(fixture.sql, {
      workspaceId: fixture.scope.workspaceId, ownerUserId: fixture.otherScope.ownerUserId,
    }, suggestion.id);
    let activityErrorCode: unknown = null;
    try {
      await activities.create(fixture.otherScope, {
        clientKey: `ab-foreign-owner-${randomUUID()}`, intentKind: "topic", intentSummary: "Continue the task",
        createIntent: { taskId: suggestion.id },
      });
    } catch (cause) { activityErrorCode = field(cause, "code"); }
    return { otherTaskNull: other === null, wrongOwnerTaskNull: wrongOwner === null, activityErrorCode };
  });

  await record("SQL12", "same acceptance request replay does not duplicate a task", "control", {
    acceptedOnReplay: true, sameDraft: true, taskCount: 1, matchingTaskCount: 1,
  }, async fixture => {
    const { plans, acceptance, accepted, suggestion } = await acceptSingleRequirement(fixture);
    const replay = await plans.acceptPlan(fixture.scope, acceptance);
    const tasks = await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope);
    return { acceptedOnReplay: replay.status === "accepted", sameDraft: replay.id === accepted.id,
      taskCount: tasks.length, matchingTaskCount: tasks.filter(row => row.id === suggestion.id).length };
  });

  console.log(`AISTUDY_AB_SQL_JSON=${JSON.stringify({
    schemaVersion: 1, suite: "adaptive-requirement-sql-comparison", scenarioCount: 12,
    timingScope: "single fixture setup + seed + scenario + cleanup, sequential execution; no latency percentile inference",
    results,
  })}`);
  // Behavioral regressions are data, rather than reasons to abort the comparator.
  expect(results).toHaveLength(12);
  expect(new Set(results.map(row => row.id)).size).toBe(12);
}, 120_000);
