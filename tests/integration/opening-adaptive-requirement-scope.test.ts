/** Real SQL: one requirement's evidence must not teach, schedule, or suppress another. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpeningPlanningSettings } from "@aistudy/contracts";
import { createMatrixExerciseSpec, matrixExerciseRequirement, matrixExerciseSkillLabel, suggestionIdentity, suggestionKey } from "@aistudy/domain";
import {
  createOpeningAdaptivePrefsRepository,
  createOpeningPlanningSettingsRepository,
  createOpeningPlansRepository,
} from "@aistudy/database";
import { createOpeningPlanService } from "../../apps/web/src/features/opening/planning/plan-service";
import { createSqlLearnerSnapshotService } from "../../apps/web/src/features/opening/planning/learner-snapshot-runtime";
import { createOpeningTeachingActivityService } from "../../apps/web/src/features/opening/teaching/activity-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { matrixAttemptFixture, matrixRequirement, matrixSkill } from "./opening-matrix-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";

const day = "2026-10-21";
const timeZone = "Asia/Shanghai";
const now = new Date(`${day}T00:00:00.000Z`);
const correctRequirement = matrixRequirement;
const incorrectRequirement = matrixExerciseRequirement(createMatrixExerciseSpec("addition"));
const correctSkill = matrixSkill;
const incorrectSkill = matrixExerciseSkillLabel("addition");
const settings: OpeningPlanningSettings = {
  weekOneMonday: "2026-10-19",
  periodTimes: { "1": { start: "08:00", end: "08:45" } },
  dailyWindow: { start: "08:00", end: "12:00" },
  lunch: { start: "12:00", end: "13:00" },
  dinner: { start: "17:30", end: "18:30" },
  sleep: { start: "23:00", end: "07:00" },
  timeZone,
};

let fixture: OpeningFixture;
beforeEach(async () => {
  fixture = await createOpeningFixture();
  await createOpeningPlanningSettingsRepository(fixture.sql).set(fixture.scope, settings);
  await createOpeningAdaptivePrefsRepository(fixture.sql).patch(fixture.scope, { autonomy: "copilot" });
});
afterEach(async () => { await fixture?.close(); });

async function seedLearnerReferenceChecks() {
  const course = await learningAttemptFixture(fixture);
  await fixture.sql`INSERT INTO course_asset_memberships
    (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility)
    VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${course.courseId}, 'source', ${course.sourceId}, 'core', 0, 'course')`;
  const reference = {
    verdictSource: "reference_checked",
    referenceSourceId: course.sourceId,
    referenceCheck: {
      referenceSourceId: course.sourceId,
      method: "Compared against the reference solution",
      scope: "whole_answer",
    },
  };
  // R1 is observed later: selecting the newest row by label would miss R2's error.
  const wrong = await course.submit(await course.start({ requirementKey: "R2" }), {
    ...reference, answer: "2", outcome: "incorrect",
  });
  const correct = await course.submit(await course.start({ requirementKey: "R1" }), reference);
  return { ...course, wrong, correct };
}

async function seedRequirementEvidence() {
  const course = await matrixAttemptFixture(fixture);
  await fixture.sql`INSERT INTO course_asset_memberships
    (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility)
    VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${course.courseId}, 'source', ${course.sourceId}, 'core', 0, 'course')`;
  const session = await course.learning.createSession(fixture.scope, {
    courseId: course.courseId, sourceIds: [course.sourceId], skillLabel: incorrectSkill,
  });
  const wrongAttempt = await course.attempts.create(fixture.scope, {
    sessionId: session.id, clientKey: randomUUID(),
    matrixExercise: { sourceId: course.sourceId, exerciseKey: "addition", variant: 0 },
  });
  const wrong = await course.submit(wrongAttempt, { answer: "[[0,0],[0,0]]", outcome: "correct" });
  const correct = await course.submit(await course.start({ variant: 0 }));
  expect(wrong).toMatchObject({ verdictSource: "deterministic", requirementKey: incorrectRequirement,
    serverEvaluation: { decision: "incorrect" }, eligibility: { independentAttempt: "yes", verifiedCorrect: "no" } });
  expect(correct).toMatchObject({ verdictSource: "deterministic", requirementKey: correctRequirement,
    serverEvaluation: { decision: "correct" }, eligibility: { independentAttempt: "yes", verifiedCorrect: "yes" } });
  return { ...course, wrong, correct };
}

function services() {
  const snapshots = createSqlLearnerSnapshotService(fixture.sql, { now: () => now });
  const plans = createOpeningPlanService(fixture.sql, {
    now: () => now,
    adaptive: { enabled: () => true, readSnapshot: snapshots.read },
  });
  // Only this repository-level test enables adaptation; compilation stays off.
  const activities = createOpeningTeachingActivityService(fixture.sql, { OPENING_ADAPTIVE_PLANNING: "1" });
  return { snapshots, plans, activities };
}

describe("adaptive requirement identity across the learning loop", () => {
  it("keeps same-label learner checks separate without promoting either to trusted evidence", async () => {
    const course = await seedLearnerReferenceChecks();
    const { snapshots, plans } = services();
    const read = await snapshots.read(fixture.scope, { date: day, timeZone });
    const source = read.sources.courses.find(row => row.courseId === course.courseId)!;
    expect(source.summaries).toHaveLength(2);
    expect(source.summaries).toEqual(expect.arrayContaining(["R1", "R2"].map(requirementKey =>
      expect.objectContaining({ skillLabel: "fractions", requirementKey, status: "needs_check" }))));
    expect(source.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: course.correct.id, skillLabel: "fractions", requirementKey: "R1", verifiedCorrect: "unknown" }),
      expect.objectContaining({ id: course.wrong.id, skillLabel: "fractions", requirementKey: "R2", verifiedCorrect: "unknown" }),
    ]));
    expect(source.observations).toHaveLength(2);
    const skills = read.snapshot.courses.find(row => row.courseId === course.courseId)!.skills;
    expect(skills).toHaveLength(2);
    expect(skills).toEqual(expect.arrayContaining(["R1", "R2"].map(requirementKey =>
      expect.objectContaining({ skillLabel: "fractions", requirementKey, status: "needs_check" }))));
    expect((await plans.getToday(fixture.scope, day)).dailyDraft?.suggestedTasks ?? []).toEqual([]);
  });

  // The current canonical matrix catalogue binds each requirement to its own
  // label. Trusted same-label/cross-requirement isolation is covered in the domain
  // tests; these SQL positives exercise the two real canonical evaluator routes.
  it.each([correctRequirement, incorrectRequirement])("matches a stored task alias for canonical requirement %s", async requirementKey => {
    const course = await seedRequirementEvidence();
    const taskId = randomUUID();
    const storedLabel = `\u3000${requirementKey === correctRequirement ? correctSkill : incorrectSkill}\u3000`;
    const clientKey = suggestionKey(day, suggestionIdentity("weak_skill", course.courseId, storedLabel, requirementKey));
    await fixture.sql`INSERT INTO opening_tasks
      (id,workspace_id,owner_user_id,title,minutes,status,course_id,skill_label,requirement_key,client_key,origin)
      VALUES (${taskId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},'Completed practice',25,'done',
        ${course.courseId},${storedLabel},${requirementKey},${clientKey},'planner')`;
    const { snapshots, plans } = services();
    const read = await snapshots.read(fixture.scope, { date: day, timeZone });
    expect(read.sources.tasks).toContainEqual(expect.objectContaining({ clientKey, skillLabel: storedLabel, requirementKey }));
    const suggestions = (await plans.getToday(fixture.scope, day)).dailyDraft?.suggestedTasks ?? [];
    expect(suggestions.map(row => row.requirementKey)).toEqual(requirementKey === correctRequirement ? [incorrectRequirement] : []);
    expect(await fixture.sql`SELECT client_key FROM opening_tasks WHERE id=${taskId}`).toEqual([{ client_key: clientKey }]);
  });

  it("keeps canonical requirements separate through snapshot, suggestion, acceptance, and teaching focus", async () => {
    const course = await seedRequirementEvidence();
    const { snapshots, plans, activities } = services();
    const read = await snapshots.read(fixture.scope, { date: day, timeZone });
    const source = read.sources.courses.find(row => row.courseId === course.courseId)!;
    expect(source.evidenceStatus).toBe("available");
    expect(source.summaries).toHaveLength(2);
    expect(source.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillLabel: correctSkill, requirementKey: correctRequirement, status: "observed_independent" }),
      expect.objectContaining({ skillLabel: incorrectSkill, requirementKey: incorrectRequirement, status: "needs_check" }),
    ]));
    expect(source.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: course.correct.id, requirementKey: correctRequirement, verifiedCorrect: "yes", usableForCurrentVersion: "yes" }),
      expect.objectContaining({ id: course.wrong.id, requirementKey: incorrectRequirement, verifiedCorrect: "no", usableForCurrentVersion: "yes" }),
    ]));
    const skills = read.snapshot.courses.find(row => row.courseId === course.courseId)!.skills;
    expect(skills).toHaveLength(2);
    expect(skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillLabel: correctSkill, requirementKey: correctRequirement, status: "observed_independent" }),
      expect.objectContaining({ skillLabel: incorrectSkill, requirementKey: incorrectRequirement, status: "needs_review" }),
    ]));

    const draft = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.suggestedTasks).toEqual([
      expect.objectContaining({ kind: "weak_skill", courseId: course.courseId, skillLabel: incorrectSkill, requirementKey: incorrectRequirement }),
    ]);
    const suggestion = draft.suggestedTasks![0]!;
    await plans.acceptPlan(fixture.scope, {
      draftId: draft.id, expectedBaseVersion: draft.baseVersion,
      clientKey: randomUUID(), acceptSuggestedKeys: [suggestion.key],
    });
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([
      expect.objectContaining({ id: suggestion.id, courseId: course.courseId, skillLabel: incorrectSkill, requirementKey: incorrectRequirement, origin: "planner" }),
    ]);
    expect(await fixture.sql`SELECT requirement_key FROM opening_tasks WHERE id=${suggestion.id}`)
      .toEqual([{ requirement_key: incorrectRequirement }]);
    expect((await readOpeningBackupRecords(fixture.sql, fixture.scope)).tables.opening_tasks)
      .toContainEqual(expect.objectContaining({ id: suggestion.id, requirement_key: incorrectRequirement }));

    const input = {
      clientKey: `requirement-teaching-${randomUUID()}`, intentKind: "topic",
      intentSummary: "Start the accepted task", createIntent: { taskId: suggestion.id },
      // The owned addition task overrides the client's dimensions focus.
      goalJson: { learnerFocus: { requirementKey: correctRequirement, focusObservationId: course.correct.id } },
    };
    const activity = await activities.create(fixture.scope, input);
    const [stored] = await fixture.sql`SELECT course_id,source_ids,goal_json FROM opening_teaching_activities
      WHERE id=${activity.id} AND workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}`;
    expect(stored).toMatchObject({
      course_id: course.courseId, source_ids: [course.sourceId],
      goal_json: { learnerFocus: {
        skillLabel: incorrectSkill, requirementKey: incorrectRequirement, activityKind: "targeted_explain",
        focusObservationId: course.wrong.id, recentAssistance: ["independent"],
      } },
    });
    await expect(activities.create(fixture.otherScope, {
      ...input, clientKey: `other-owner-${randomUUID()}`,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not let a pending dimensions task suppress addition, and drops stale addition errors after a source update", async () => {
    const course = await seedRequirementEvidence();
    const pendingTaskId = randomUUID();
    await fixture.sql`INSERT INTO opening_tasks
      (id,workspace_id,owner_user_id,title,minutes,status,course_id,skill_label,requirement_key,origin)
      VALUES (${pendingTaskId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},'Dimensions practice',25,'pending',
        ${course.courseId},${correctSkill},${correctRequirement},'manual')`;
    const { snapshots, plans, activities } = services();
    const draft = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.suggestedTasks).toEqual([
      expect.objectContaining({ courseId: course.courseId, skillLabel: incorrectSkill, requirementKey: incorrectRequirement, kind: "weak_skill" }),
    ]);
    const dimensionActivity = await activities.create(fixture.scope, {
      clientKey: `dimensions-requirement-${randomUUID()}`, intentKind: "topic",
      intentSummary: "Continue the dimensions task", createIntent: { taskId: pendingTaskId },
    });
    const [dimensionStored] = await fixture.sql`SELECT goal_json FROM opening_teaching_activities WHERE id=${dimensionActivity.id}`;
    expect(dimensionStored?.goal_json?.learnerFocus).toMatchObject({
      requirementKey: correctRequirement, activityKind: "transfer_check", focusObservationId: null,
    });

    // A newer source remains ready and usable; only the old evidence loses applicability.
    await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${course.sourceId}`;
    await backupRows(fixture.sql, fixture.scope).chunk(course.sourceId, 2);
    const read = await snapshots.read(fixture.scope, { date: day, timeZone });
    expect(read.snapshot.courses.find(row => row.courseId === course.courseId)).toMatchObject({ hasUsableMaterials: true });
    const historical = read.sources.courses.find(row => row.courseId === course.courseId)?.observations.find(row => row.id === course.wrong.id);
    expect(historical).toMatchObject({ requirementKey: incorrectRequirement, verifiedCorrect: "no" });
    expect(historical?.usableForCurrentVersion).not.toBe("yes");
    expect(read.snapshot.courses.find(row => row.courseId === course.courseId)?.skills)
      .not.toContainEqual(expect.objectContaining({ requirementKey: incorrectRequirement, status: "needs_review" }));
    const refreshed = (await plans.getToday(fixture.scope, day, { refreshSuggestions: true })).dailyDraft!;
    expect(refreshed.suggestedTasks ?? []).toEqual([]);
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([
      expect.objectContaining({ id: pendingTaskId, requirementKey: correctRequirement, status: "pending" }),
    ]);

    // An explicit addition task must not reuse its historical error as current evidence.
    const additionTaskId = randomUUID();
    await fixture.sql`INSERT INTO opening_tasks
      (id,workspace_id,owner_user_id,title,minutes,status,course_id,skill_label,requirement_key,origin)
      VALUES (${additionTaskId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},'Addition practice',25,'pending',
        ${course.courseId},${incorrectSkill},${incorrectRequirement},'manual')`;
    const activity = await activities.create(fixture.scope, {
      clientKey: `stale-requirement-${randomUUID()}`, intentKind: "topic",
      intentSummary: "Continue the addition task", createIntent: { taskId: additionTaskId },
    });
    const [stored] = await fixture.sql`SELECT goal_json FROM opening_teaching_activities WHERE id=${activity.id}`;
    expect(stored?.goal_json?.learnerFocus).toMatchObject({ requirementKey: incorrectRequirement, activityKind: "diagnose", focusObservationId: null });
  });
});
