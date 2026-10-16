/** Real SQL: one requirement's evidence must not teach, schedule, or suppress another. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpeningPlanningSettings } from "@aistudy/contracts";
import { suggestionIdentity, suggestionKey } from "@aistudy/domain";
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
import { backupRows } from "./opening-backup-records-fixture";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";

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

let fixture: OpeningFixture;
beforeEach(async () => {
  fixture = await createOpeningFixture();
  await createOpeningPlanningSettingsRepository(fixture.sql).set(fixture.scope, settings);
  await createOpeningAdaptivePrefsRepository(fixture.sql).patch(fixture.scope, { autonomy: "copilot" });
});
afterEach(async () => { await fixture?.close(); });

async function seedRequirementEvidence() {
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
  it.each(["R1", "R2"])("matches stored task aliases only inside requirement %s", async requirementKey => {
    const course = await seedRequirementEvidence();
    const taskId = randomUUID();
    const storedLabel = " ＦＲＡＣＴＩＯＮＳ ";
    const clientKey = suggestionKey(day, suggestionIdentity("weak_skill", course.courseId, storedLabel, requirementKey));
    await fixture.sql`INSERT INTO opening_tasks
      (id,workspace_id,owner_user_id,title,minutes,status,course_id,skill_label,requirement_key,client_key,origin)
      VALUES (${taskId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},'Completed practice',25,'done',
        ${course.courseId},${storedLabel},${requirementKey},${clientKey},'planner')`;
    const { snapshots, plans } = services();
    const read = await snapshots.read(fixture.scope, { date: day, timeZone });
    expect(read.sources.tasks).toContainEqual(expect.objectContaining({ clientKey, skillLabel: storedLabel, requirementKey }));
    const suggestions = (await plans.getToday(fixture.scope, day)).dailyDraft?.suggestedTasks ?? [];
    expect(suggestions.map(row => row.requirementKey)).toEqual(requirementKey === "R1" ? ["R2"] : []);
    expect(await fixture.sql`SELECT client_key FROM opening_tasks WHERE id=${taskId}`).toEqual([{ client_key: clientKey }]);
  });

  it("keeps same-label requirements separate through snapshot, suggestion, acceptance, and teaching focus", async () => {
    const course = await seedRequirementEvidence();
    const { snapshots, plans, activities } = services();
    const read = await snapshots.read(fixture.scope, { date: day, timeZone });
    const source = read.sources.courses.find(row => row.courseId === course.courseId)!;
    expect(source.evidenceStatus).toBe("available");
    expect(source.summaries).toHaveLength(2);
    expect(source.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillLabel: "fractions", requirementKey: "R1", status: "observed_independent" }),
      expect.objectContaining({ skillLabel: "fractions", requirementKey: "R2", status: "needs_check" }),
    ]));
    expect(source.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: course.correct.id, requirementKey: "R1", verifiedCorrect: "yes", usableForCurrentVersion: "yes" }),
      expect.objectContaining({ id: course.wrong.id, requirementKey: "R2", verifiedCorrect: "no", usableForCurrentVersion: "yes" }),
    ]));
    const skills = read.snapshot.courses.find(row => row.courseId === course.courseId)!.skills;
    expect(skills).toHaveLength(2);
    expect(skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillLabel: "fractions", requirementKey: "R1", status: "observed_independent" }),
      expect.objectContaining({ skillLabel: "fractions", requirementKey: "R2", status: "needs_review" }),
    ]));

    const draft = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.suggestedTasks).toEqual([
      expect.objectContaining({ kind: "weak_skill", courseId: course.courseId, skillLabel: "fractions", requirementKey: "R2" }),
    ]);
    const suggestion = draft.suggestedTasks![0]!;
    await plans.acceptPlan(fixture.scope, {
      draftId: draft.id, expectedBaseVersion: draft.baseVersion,
      clientKey: randomUUID(), acceptSuggestedKeys: [suggestion.key],
    });
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([
      expect.objectContaining({ id: suggestion.id, courseId: course.courseId, skillLabel: "fractions", requirementKey: "R2", origin: "planner" }),
    ]);
    expect(await fixture.sql`SELECT requirement_key FROM opening_tasks WHERE id=${suggestion.id}`)
      .toEqual([{ requirement_key: "R2" }]);
    expect((await readOpeningBackupRecords(fixture.sql, fixture.scope)).tables.opening_tasks)
      .toContainEqual(expect.objectContaining({ id: suggestion.id, requirement_key: "R2" }));

    const input = {
      clientKey: `requirement-teaching-${randomUUID()}`, intentKind: "topic",
      intentSummary: "Start the accepted task", createIntent: { taskId: suggestion.id },
      // Derived focus must come from the owned task, even if the client supplies R1.
      goalJson: { learnerFocus: { requirementKey: "R1", focusObservationId: course.correct.id } },
    };
    const activity = await activities.create(fixture.scope, input);
    const [stored] = await fixture.sql`SELECT course_id,source_ids,goal_json FROM opening_teaching_activities
      WHERE id=${activity.id} AND workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}`;
    expect(stored).toMatchObject({
      course_id: course.courseId, source_ids: [course.sourceId],
      goal_json: { learnerFocus: {
        skillLabel: "fractions", requirementKey: "R2", activityKind: "targeted_explain",
        focusObservationId: course.wrong.id, recentAssistance: ["independent"],
      } },
    });
    await expect(activities.create(fixture.otherScope, {
      ...input, clientKey: `other-owner-${randomUUID()}`,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not let an R1 pending task suppress R2, and stops teaching from stale R2 errors after a source update", async () => {
    const course = await seedRequirementEvidence();
    const pendingTaskId = randomUUID();
    await fixture.sql`INSERT INTO opening_tasks
      (id,workspace_id,owner_user_id,title,minutes,status,course_id,skill_label,requirement_key,origin)
      VALUES (${pendingTaskId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},'R1 practice',25,'pending',
        ${course.courseId},'fractions','R1','manual')`;
    const { snapshots, plans, activities } = services();
    const draft = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.suggestedTasks).toEqual([
      expect.objectContaining({ courseId: course.courseId, skillLabel: "fractions", requirementKey: "R2", kind: "weak_skill" }),
    ]);
    const r1Activity = await activities.create(fixture.scope, {
      clientKey: `r1-requirement-${randomUUID()}`, intentKind: "topic",
      intentSummary: "Continue the R1 task", createIntent: { taskId: pendingTaskId },
    });
    const [r1Stored] = await fixture.sql`SELECT goal_json FROM opening_teaching_activities WHERE id=${r1Activity.id}`;
    expect(r1Stored?.goal_json?.learnerFocus).toMatchObject({
      requirementKey: "R1", activityKind: "transfer_check", focusObservationId: null,
    });

    // A newer source remains ready and usable; only the old evidence loses applicability.
    await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${course.sourceId}`;
    await backupRows(fixture.sql, fixture.scope).chunk(course.sourceId, 2);
    const read = await snapshots.read(fixture.scope, { date: day, timeZone });
    expect(read.snapshot.courses.find(row => row.courseId === course.courseId)).toMatchObject({ hasUsableMaterials: true });
    const historical = read.sources.courses.find(row => row.courseId === course.courseId)?.observations.find(row => row.id === course.wrong.id);
    expect(historical).toMatchObject({ requirementKey: "R2", verifiedCorrect: "no" });
    expect(historical?.usableForCurrentVersion).not.toBe("yes");
    expect(read.snapshot.courses.find(row => row.courseId === course.courseId)?.skills)
      .not.toContainEqual(expect.objectContaining({ requirementKey: "R2", status: "needs_review" }));
    const refreshed = (await plans.getToday(fixture.scope, day, { refreshSuggestions: true })).dailyDraft!;
    expect(refreshed.suggestedTasks ?? []).toEqual([]);
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([
      expect.objectContaining({ id: pendingTaskId, requirementKey: "R1", status: "pending" }),
    ]);

    // Start an R2 task explicitly so a same-label ambiguity cannot mask stale evidence use.
    const r2TaskId = randomUUID();
    await fixture.sql`INSERT INTO opening_tasks
      (id,workspace_id,owner_user_id,title,minutes,status,course_id,skill_label,requirement_key,origin)
      VALUES (${r2TaskId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},'R2 practice',25,'pending',
        ${course.courseId},'fractions','R2','manual')`;
    const activity = await activities.create(fixture.scope, {
      clientKey: `stale-requirement-${randomUUID()}`, intentKind: "topic",
      intentSummary: "Continue the R2 task", createIntent: { taskId: r2TaskId },
    });
    const [stored] = await fixture.sql`SELECT goal_json FROM opening_teaching_activities WHERE id=${activity.id}`;
    expect(stored?.goal_json?.learnerFocus).toMatchObject({ requirementKey: "R2", activityKind: "diagnose", focusObservationId: null });
  });
});
