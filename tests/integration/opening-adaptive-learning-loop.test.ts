/** Real SQL evidence → learner snapshot → Today draft; C3 acceptance is covered separately. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpeningPlanningSettings, PlanDraft, TeachingLearnerFocus } from "@aistudy/contracts";
import {
  createOpeningAdaptivePrefsRepository,
  createOpeningKnowledgeRepository,
  createOpeningPlanningSettingsRepository,
  createOpeningPlansRepository,
  readOpeningLearnerSnapshotBase,
  readOpeningTeachingCompilerFocus,
  readOpeningTeachingTaskFocus,
} from "@aistudy/database";
import { ADAPTIVE_STRATEGY_VERSION, addLocalDays, suggestionIdentity, suggestionKey } from "@aistudy/domain";
import { readOpeningCourseObservationHeads } from "../../packages/database/src/repositories/opening-learning-read";
import { createOpeningPlanService } from "../../apps/web/src/features/opening/planning/plan-service";
import { createSqlLearnerSnapshotService } from "../../apps/web/src/features/opening/planning/learner-snapshot-runtime";
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

let fixture: OpeningFixture;
beforeEach(async () => {
  // Each test has its own workspace; no global truncation can remove another fixture's data.
  fixture = await createOpeningFixture();
  await createOpeningPlanningSettingsRepository(fixture.sql).set(fixture.scope, settings);
  await createOpeningAdaptivePrefsRepository(fixture.sql).patch(fixture.scope, { autonomy: "copilot" });
});
afterEach(async () => { await fixture?.close(); });

type AttemptFixture = Awaited<ReturnType<typeof learningAttemptFixture>>;

async function seedCourse() {
  const course = await learningAttemptFixture(fixture);
  await fixture.sql`INSERT INTO course_asset_memberships
    (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility)
    VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${course.courseId}, 'source', ${course.sourceId}, 'core', 0, 'course')`;
  return course;
}

async function submitVerifiedError(course: AttemptFixture, requirementKey?: string) {
  return course.submit(await course.start({ requirementKey }), {
    answer: "2", outcome: "incorrect", verdictSource: "reference_checked", referenceSourceId: course.sourceId,
    referenceCheck: { referenceSourceId: course.sourceId, method: "Compared against the reference solution", scope: "whole_answer" },
  });
}

async function storeTeachingFocus(course: AttemptFixture, observationId: string | null, overrides: Partial<TeachingLearnerFocus> = {}) {
  const learnerFocus: TeachingLearnerFocus = {
    skillLabel: "fractions", activityKind: "targeted_explain", reasonCode: "verified_error",
    focusObservationId: observationId, recentAssistance: ["independent"], strategyVersion: ADAPTIVE_STRATEGY_VERSION, ...overrides,
  };
  const [activity] = await fixture.sql`UPDATE opening_teaching_activities SET goal_json=${fixture.sql.json({ learnerFocus })}
    WHERE id=(SELECT activity_id FROM opening_learning_sessions WHERE id=${course.sessionId})
      AND workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}
    RETURNING id`;
  return { activityId: String(activity!.id), learnerFocus };
}

function services(enabled = true, clock = () => now) {
  const snapshots = createSqlLearnerSnapshotService(fixture.sql, { now: clock });
  const readSnapshot = vi.fn(snapshots.read);
  const plans = createOpeningPlanService(fixture.sql, {
    now: clock,
    adaptive: { enabled: () => enabled, readSnapshot },
  });
  return { snapshots, readSnapshot, plans };
}

async function seedPlannerTask(courseId: string, date: string, status: "done" | "skipped" | "pending") {
  const identity = suggestionIdentity("weak_skill", courseId, "fractions");
  const clientKey = suggestionKey(date, identity);
  await fixture.sql`INSERT INTO opening_tasks
    (id, workspace_id, owner_user_id, title, minutes, status, client_key, course_id, skill_label, origin)
    VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, 'Existing practice',
      25, ${status}, ${clientKey}, ${courseId}, 'fractions', 'planner')`;
  return identity;
}

function planningResult(draft: PlanDraft) {
  return {
    date: draft.date, baseVersion: draft.baseVersion, status: draft.status,
    blocks: draft.blocks, unscheduledTaskIds: draft.unscheduledTaskIds, unscheduled: draft.unscheduled,
    reasons: draft.reasons,
  };
}

describe("adaptive learning loop with real evidence", () => {
  it.each(["transfer_check", "reduced_help_practice"] as const)("rechecks current evidence for %s even without a focus observation", async (activityKind) => {
    const course = await seedCourse();
    const attempt = await course.start({ requirementKey: "R1" });
    if (activityKind === "reduced_help_practice") await course.help(attempt);
    await course.submit(attempt, { verdictSource: "reference_checked", referenceSourceId: course.sourceId,
      assistance: activityKind === "reduced_help_practice" ? "hinted" : "independent",
      referenceCheck: { referenceSourceId: course.sourceId, method: "Reference comparison", scope: "whole_answer" } });
    const { activityId, learnerFocus } = await storeTeachingFocus(course, null, { activityKind, requirementKey: "R1",
      recentAssistance: [activityKind === "reduced_help_practice" ? "hinted" : "independent"] });
    expect(await readOpeningTeachingCompilerFocus(fixture.sql, fixture.scope, activityId)).toEqual({ learnerFocus });
    await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${course.sourceId}`;
    await backupRows(fixture.sql, fixture.scope).chunk(course.sourceId, 2);
    expect(await readOpeningTeachingCompilerFocus(fixture.sql, fixture.scope, activityId)).toEqual({});
  });

  it("reads the accepted task's requirement only inside its owner scope", async () => {
    const course = await seedCourse();
    const taskId = randomUUID();
    await fixture.sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, course_id, skill_label, requirement_key)
      VALUES (${taskId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, 'Formula correction', 10,
        ${course.courseId}, 'fractions', 'formula-application')`;
    expect(await readOpeningTeachingTaskFocus(fixture.sql, fixture.scope, taskId)).toEqual({
      title: "Formula correction", courseId: course.courseId, skillLabel: "fractions", requirementKey: "formula-application",
    });
    expect(await readOpeningTeachingTaskFocus(fixture.sql, fixture.otherScope, taskId)).toBeNull();
    expect(await readOpeningTeachingTaskFocus(fixture.sql, {
      workspaceId: fixture.scope.workspaceId, ownerUserId: fixture.otherScope.ownerUserId,
    }, taskId)).toBeNull();
  });

  it("compiles a current verified error only for the owning scope", async () => {
    const course = await seedCourse();
    const wrong = await submitVerifiedError(course);
    const { activityId, learnerFocus } = await storeTeachingFocus(course, wrong.id);

    expect(await readOpeningTeachingCompilerFocus(fixture.sql, fixture.scope, activityId)).toEqual({
      learnerFocus, focusAttempt: { question: "1/2 + 1/2?", answer: "2" },
    });
    expect(await readOpeningTeachingCompilerFocus(fixture.sql, fixture.otherScope, activityId)).toEqual({});
    expect(await readOpeningTeachingCompilerFocus(fixture.sql, {
      workspaceId: fixture.scope.workspaceId, ownerUserId: fixture.otherScope.ownerUserId,
    }, activityId)).toEqual({});
  });

  it.each([null, "formula-application"])("compiles a current error with matching requirement %s", async (requirementKey) => {
    const course = await seedCourse();
    const wrong = await submitVerifiedError(course, requirementKey ?? undefined);
    const { activityId, learnerFocus } = await storeTeachingFocus(course, wrong.id, { requirementKey });
    expect(await readOpeningTeachingCompilerFocus(fixture.sql, fixture.scope, activityId)).toEqual({
      learnerFocus, focusAttempt: { question: "1/2 + 1/2?", answer: "2" },
    });
  });

  it("compiles a matching requirement when the observation uses a normalized skill alias", async () => {
    const course = await seedCourse();
    const alias = "  ＦＲＡＣＴＩＯＮＳ  ";
    const session = await course.learning.createSession(fixture.scope, {
      courseId: course.courseId, skillLabel: alias, sourceIds: [course.sourceId],
    });
    const wrong = await course.submit(await course.start({ sessionId: session.id, requirementKey: "formula-application" }), {
      sessionId: session.id, skillLabel: alias, answer: "2", outcome: "incorrect",
      verdictSource: "reference_checked", referenceSourceId: course.sourceId,
      referenceCheck: { referenceSourceId: course.sourceId, method: "Compared against the reference solution", scope: "whole_answer" },
    });
    const { activityId, learnerFocus } = await storeTeachingFocus(course, wrong.id, { requirementKey: "formula-application" });
    expect(await readOpeningTeachingCompilerFocus(fixture.sql, fixture.scope, activityId)).toEqual({
      learnerFocus, focusAttempt: { question: "1/2 + 1/2?", answer: "2" },
    });
  });

  it.each([
    { requirementKey: "different-requirement" },
    { requirementKey: null },
    { requirementKey: "formula-application", skillLabel: "different skill" },
  ])("does not compile a current error outside the persisted requirement/skill focus %j", async (focus) => {
    const course = await seedCourse();
    const wrong = await submitVerifiedError(course, "formula-application");
    const { activityId } = await storeTeachingFocus(course, wrong.id, focus);
    expect(await readOpeningTeachingCompilerFocus(fixture.sql, fixture.scope, activityId)).toEqual({});
  });

  it.each([
    { change: "changed_source_version", usableForCurrentVersion: "unknown", reason: "version_changed_needs_check" },
    { change: "unavailable_historical_version", usableForCurrentVersion: "no", reason: "version_unavailable" },
    { change: "unknown_captured_version", usableForCurrentVersion: "unknown", reason: "version_unknown" },
  ] as const)("keeps $change evidence in history without compiling it as a current weakness", async ({ change, usableForCurrentVersion, reason }) => {
    const course = await seedCourse();
    const wrong = await submitVerifiedError(course);
    const { activityId } = await storeTeachingFocus(course, wrong.id);

    if (change !== "unknown_captured_version") {
      await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${course.sourceId}`;
      // The course still has current usable material; only the captured evidence is stale.
      await backupRows(fixture.sql, fixture.scope).chunk(course.sourceId, 2);
    }
    if (change === "unavailable_historical_version") {
      await fixture.sql`UPDATE opening_source_versions SET availability='unavailable'
        WHERE source_id=${course.sourceId} AND version=1 AND workspace_id=${fixture.scope.workspaceId}`;
    } else if (change === "unknown_captured_version") {
      // Legacy evidence may not identify the captured source version.
      await fixture.sql`UPDATE opening_learning_observations SET source_versions=NULL WHERE id=${wrong.id}`;
    }

    const history = await readOpeningCourseObservationHeads(fixture.sql, fixture.scope, course.courseId);
    expect(history).toEqual([expect.objectContaining({
      id: wrong.id, answer: "2", outcome: "incorrect",
      eligibility: expect.objectContaining({ verifiedCorrect: "no", usableForCurrentVersion, reasonCodes: expect.arrayContaining([reason]) }),
    })]);
    expect(await readOpeningTeachingCompilerFocus(fixture.sql, fixture.scope, activityId)).toEqual({});
  });

  it("turns a verified independent error into a weak-skill Today suggestion without creating a task", async () => {
    const course = await seedCourse();
    const wrong = await submitVerifiedError(course);
    const { snapshots, plans } = services();
    const read = await snapshots.read(fixture.scope, { date: day, timeZone });

    expect(read.sources.courses.find((row) => row.courseId === course.courseId)).toMatchObject({
      evidenceStatus: "available", hasUsableMaterials: true,
      observations: [expect.objectContaining({ id: wrong.id, verifiedCorrect: "no", independentAttempt: "yes" })],
      summaries: [expect.objectContaining({ skillLabel: "fractions", status: "needs_check" })],
    });
    expect(read.snapshot.courses.find((row) => row.courseId === course.courseId)?.skills).toEqual([
      expect.objectContaining({ skillLabel: "fractions", status: "needs_review", recentAssistance: ["independent"] }),
    ]);

    const draft = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.strategyVersion).toBe(ADAPTIVE_STRATEGY_VERSION);
    expect(draft.suggestedTasks).toEqual([
      expect.objectContaining({ kind: "weak_skill", courseId: course.courseId, skillLabel: "fractions" }),
    ]);
    const suggestion = draft.suggestedTasks![0]!;
    expect(draft.reasons?.[suggestion.id]).toMatchObject({ code: "weak_skill" });
    expect(draft.blocks.map((block) => block.taskId)).toContain(suggestion.id);
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
  });

  it("does not treat unverified independent answers as wrong or invent a weak-skill suggestion", async () => {
    const course = await seedCourse();
    const unverified = await course.submit(await course.start());
    const { snapshots, plans } = services();
    const read = await snapshots.read(fixture.scope, { date: day, timeZone });
    expect(read.sources.courses[0]!.observations).toEqual([
      expect.objectContaining({ id: unverified.id, verifiedCorrect: "unknown" }),
    ]);
    expect(read.snapshot.courses[0]!.skills[0]!.status).toBe("needs_check");
    const draft = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.suggestedTasks ?? []).toEqual([]);
    expect(draft.blocks).toEqual([]);
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
  });

  it("combines whitespace and case aliases into one skill and one suggestion from all observations", async () => {
    const course = await seedCourse();
    const first = await submitVerifiedError(course);
    const alias = "  FRACTIONS  ";
    const session = await course.learning.createSession(fixture.scope, {
      courseId: course.courseId, skillLabel: alias, sourceIds: [course.sourceId],
    });
    const second = await course.submit(await course.start({ sessionId: session.id }), {
      sessionId: session.id, skillLabel: alias, answer: "2", outcome: "incorrect",
      verdictSource: "reference_checked", referenceSourceId: course.sourceId,
      referenceCheck: { referenceSourceId: course.sourceId, method: "Compared against the reference solution", scope: "whole_answer" },
    });
    const { snapshots, plans } = services();
    const read = await snapshots.read(fixture.scope, { date: day, timeZone });
    const evidence = read.sources.courses.find((row) => row.courseId === course.courseId)!;
    expect(evidence.observations).toHaveLength(2);
    expect(evidence.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, skillLabel: "fractions" }),
      expect.objectContaining({ id: second.id, skillLabel: "fractions" }),
    ]));
    expect(evidence.summaries).toEqual([expect.objectContaining({ skillLabel: "fractions", status: "needs_check" })]);
    expect(read.snapshot.courses.find((row) => row.courseId === course.courseId)?.skills).toEqual([
      expect.objectContaining({ skillLabel: "fractions", status: "needs_review", recentAssistance: ["independent", "independent"] }),
    ]);
    const draft = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.suggestedTasks).toEqual([
      expect.objectContaining({ kind: "weak_skill", courseId: course.courseId, skillLabel: "fractions" }),
    ]);
    expect(draft.blocks).toHaveLength(1);
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
  });

  it.each(["done", "skipped"] as const)("does not revive today's %s suggestion when a real draft is refreshed", async (status) => {
    const course = await seedCourse();
    await submitVerifiedError(course);
    const { snapshots, plans } = services();
    const first = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(first.suggestedTasks).toHaveLength(1);
    const identity = await seedPlannerTask(course.courseId, day, status);
    expect((await snapshots.read(fixture.scope, { date: day, timeZone })).snapshot.plannerHistory)
      .toContainEqual({ date: day, identity, status });

    const refreshed = (await plans.getToday(fixture.scope, day, { refreshSuggestions: true })).dailyDraft!;
    expect(refreshed.id).not.toBe(first.id);
    expect(refreshed.suggestedTasks ?? []).toEqual([]);
    expect(refreshed.blocks).toEqual([]);
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope))
      .toEqual([expect.objectContaining({ status, courseId: course.courseId, origin: "planner" })]);
  });

  it("suppresses an earlier pending planner task while keeping that existing task in the plan", async () => {
    const course = await seedCourse();
    await submitVerifiedError(course);
    const earlier = addLocalDays(day, -1);
    const identity = await seedPlannerTask(course.courseId, earlier, "pending");
    const { snapshots, plans } = services();
    expect((await snapshots.read(fixture.scope, { date: day, timeZone })).snapshot.plannerHistory)
      .toContainEqual({ date: earlier, identity, status: "pending" });
    const draft = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.suggestedTasks ?? []).toEqual([]);
    const tasks = await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope);
    expect(tasks).toHaveLength(1);
    expect(draft.blocks.map((block) => block.taskId)).toEqual([tasks[0]!.id]);
  });

  it("matches the original rule draft for the same data while disabled and never reads the snapshot", async () => {
    const course = await seedCourse();
    await submitVerifiedError(course);
    await createOpeningPlansRepository(fixture.sql).createTask(fixture.scope, {
      title: "Existing assignment", minutes: 30, dueAt: null, priority: 1, candidateId: null,
    });
    const { plans, readSnapshot } = services(false);
    const disabled = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(disabled.blocks).toHaveLength(1);
    expect(disabled.suggestedTasks).toBeUndefined();
    expect(disabled.strategyVersion).toBeUndefined();
    expect(readSnapshot).not.toHaveBeenCalled();

    // Recompute through the old entry point; reusing the stored draft would not check equivalence.
    await fixture.sql`DELETE FROM opening_plan_drafts WHERE id = ${disabled.id} AND workspace_id = ${fixture.scope.workspaceId}`;
    const original = (await createOpeningPlanService(fixture.sql, { now: () => now }).getToday(fixture.scope, day)).dailyDraft!;
    expect(original.id).not.toBe(disabled.id);
    expect(planningResult(disabled)).toEqual(planningResult(original));
  });

  it("honors the persisted manual preference even when real evidence warrants review", async () => {
    const course = await seedCourse();
    await submitVerifiedError(course);
    await createOpeningAdaptivePrefsRepository(fixture.sql).patch(fixture.scope, { autonomy: "manual" });
    const { snapshots, plans } = services();
    expect((await snapshots.read(fixture.scope, { date: day, timeZone })).autonomy).toBe("manual");
    const draft = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.suggestedTasks ?? []).toEqual([]);
    expect(draft.blocks).toEqual([]);
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
  });

  it("offers changed learning advice without replacing an executable open draft until requested", async () => {
    const course = await seedCourse();
    const { plans } = services();
    const first = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(first.suggestedTasks ?? []).toEqual([]);
    await submitVerifiedError(course);

    const offered = await plans.getToday(fixture.scope, day);
    expect(offered.dailyDraft!.id).toBe(first.id);
    expect(offered.dailyDraft!.suggestedTasks ?? []).toEqual([]);
    expect(offered.hasNewerSuggestion).toBe(true);

    const refreshed = await plans.getToday(fixture.scope, day, { refreshSuggestions: true });
    expect(refreshed.dailyDraft!.id).not.toBe(first.id);
    expect(refreshed.dailyDraft!.suggestedTasks).toEqual([
      expect.objectContaining({ kind: "weak_skill", courseId: course.courseId, skillLabel: "fractions" }),
    ]);
    expect(refreshed.hasNewerSuggestion).toBeUndefined();
    const rows = await fixture.sql`SELECT id FROM opening_plan_drafts
      WHERE workspace_id = ${fixture.scope.workspaceId} AND day = ${day}::date AND status = 'draft'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(refreshed.dailyDraft!.id);
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
  });

  it("replaces an expired adaptive slot with a future draft that can be accepted", async () => {
    const course = await seedCourse();
    await submitVerifiedError(course);
    let current = now;
    const { plans } = services(true, () => current);
    const repo = createOpeningPlansRepository(fixture.sql, { now: () => current });
    const first = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(first.blocks).toHaveLength(1);
    expect(Date.parse(first.blocks[0]!.start)).toBeGreaterThan(current.getTime());

    current = new Date(Date.parse(first.blocks[0]!.start) + 1_000);
    await expect(repo.acceptPlan(fixture.scope, {
      draftId: first.id, expectedBaseVersion: first.baseVersion, clientKey: randomUUID(),
      acceptSuggestedKeys: [first.suggestedTasks![0]!.key],
    })).rejects.toMatchObject({ code: "CONFLICT", reason: "slot_expired" });
    expect(await repo.listTasks(fixture.scope)).toEqual([]);

    const refreshed = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(refreshed.id).not.toBe(first.id);
    expect(refreshed.blocks).toHaveLength(1);
    expect(Date.parse(refreshed.blocks[0]!.start)).toBeGreaterThan(current.getTime());
    const accepted = await plans.acceptPlan(fixture.scope, {
      draftId: refreshed.id, expectedBaseVersion: refreshed.baseVersion, clientKey: randomUUID(),
      acceptSuggestedKeys: [refreshed.suggestedTasks![0]!.key],
    });
    expect(accepted).toMatchObject({ id: refreshed.id, status: "accepted", blocks: refreshed.blocks });
    expect(await repo.listTasks(fixture.scope)).toEqual([
      expect.objectContaining({ id: refreshed.suggestedTasks![0]!.id, status: "pending", courseId: course.courseId, origin: "planner" }),
    ]);
    expect((await plans.getToday(fixture.scope, day)).blocks).toEqual(accepted.blocks);
  });

  it("rejects an older adaptive draft without material fingerprints and automatically rebuilds it", async () => {
    const course = await seedCourse();
    await submitVerifiedError(course);
    const { plans } = services();
    const first = (await plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(first.suggestedTasks).toEqual([expect.objectContaining({ courseId: course.courseId, kind: "weak_skill" })]);
    await fixture.sql`UPDATE opening_plan_drafts SET input_snapshot=input_snapshot - 'courseMaterialRevisions'
      WHERE id=${first.id} AND workspace_id=${fixture.scope.workspaceId}`;

    await expect(plans.acceptPlan(fixture.scope, {
      draftId: first.id, expectedBaseVersion: first.baseVersion, clientKey: randomUUID(),
      acceptSuggestedKeys: [first.suggestedTasks![0]!.key],
    })).rejects.toMatchObject({ code: "CONFLICT", reason: "source_unavailable" });
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
    expect(await fixture.sql`SELECT draft_id FROM opening_plan_acceptances WHERE draft_id=${first.id}`).toEqual([]);
    expect(await fixture.sql`SELECT status FROM opening_plan_drafts WHERE id=${first.id}`).toEqual([{ status: "draft" }]);

    const refreshed = await plans.getToday(fixture.scope, day);
    const replacement = refreshed.dailyDraft!;
    expect(replacement.id).not.toBe(first.id);
    expect(refreshed.hasNewerSuggestion).toBeUndefined();
    expect(replacement.suggestedTasks).toEqual(first.suggestedTasks);
    const [stored] = await fixture.sql`SELECT input_snapshot FROM opening_plan_drafts WHERE id=${replacement.id}`;
    expect(stored?.input_snapshot?.courseMaterialRevisions).toEqual({ [course.courseId]: expect.any(String) });
    await expect(plans.acceptPlan(fixture.scope, {
      draftId: replacement.id, expectedBaseVersion: replacement.baseVersion, clientKey: randomUUID(),
      acceptSuggestedKeys: [replacement.suggestedTasks![0]!.key],
    })).resolves.toMatchObject({ id: replacement.id, status: "accepted", blocks: replacement.blocks });
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([
      expect.objectContaining({ id: replacement.suggestedTasks![0]!.id, courseId: course.courseId, status: "pending" }),
    ]);
  });

  it.each(["material_excluded", "course_archived", "current_version_without_chunks"] as const)(
    "rebuilds the draft after %s so it no longer offers an unavailable course",
    async (change) => {
      const course = await seedCourse();
      await submitVerifiedError(course);
      const { snapshots, plans } = services();
      const first = (await plans.getToday(fixture.scope, day)).dailyDraft!;
      expect(first.suggestedTasks).toEqual([expect.objectContaining({ courseId: course.courseId, kind: "weak_skill" })]);
      expect(first.blocks).toHaveLength(1);

      if (change === "material_excluded") {
        await fixture.sql`INSERT INTO opening_privacy_exclusions (workspace_id, source_id, deleted_at)
          VALUES (${fixture.scope.workspaceId}, ${course.sourceId}, now())`;
        await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch + 1 WHERE id=${fixture.scope.workspaceId}`;
      } else if (change === "course_archived") {
        await fixture.sql`UPDATE courses SET archived_at=now()
          WHERE id=${course.courseId} AND workspace_id=${fixture.scope.workspaceId}`;
      } else {
        // Ready is not sufficient: chunks of an older version cannot admit the new version.
        await fixture.sql`UPDATE opening_sources SET version=version + 1, parse_state='ready'
          WHERE id=${course.sourceId} AND workspace_id=${fixture.scope.workspaceId}`;
        expect(await fixture.sql`SELECT source_version FROM opening_source_chunks WHERE source_id=${course.sourceId}`)
          .toEqual([{ source_version: 1 }]);
      }

      const read = await snapshots.read(fixture.scope, { date: day, timeZone });
      expect(read.snapshot.courses.filter((row) => row.hasUsableMaterials).map((row) => row.courseId)).not.toContain(course.courseId);
      const today = await plans.getToday(fixture.scope, day);
      const replacement = today.dailyDraft!;
      expect(replacement.id).not.toBe(first.id);
      expect(replacement.suggestedTasks ?? []).toEqual([]);
      expect(replacement.blocks).toEqual([]);
      expect(replacement.unscheduledTaskIds).toEqual([]);
      expect(today.hasNewerSuggestion).toBeUndefined();
      expect(await fixture.sql`SELECT id FROM opening_plan_drafts
        WHERE workspace_id=${fixture.scope.workspaceId} AND day=${day}::date AND status='draft'`)
        .toEqual([{ id: replacement.id }]);
      expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
      await expect(plans.acceptPlan(fixture.scope, {
        draftId: replacement.id, expectedBaseVersion: replacement.baseVersion, clientKey: randomUUID(), acceptSuggestedKeys: [],
      })).resolves.toMatchObject({ id: replacement.id, status: "accepted", blocks: [] });
    },
  );

  it.each(["source_excluded", "source_version_changed", "source_unlinked", "replace_chunk_same_version"] as const)(
    "does not use a knowledge graph after %s even while another course material remains usable",
    async (change) => {
      const course = await seedCourse();
      const rows = backupRows(fixture.sql, fixture.scope);
      const secondSourceId = await rows.source();
      await rows.chunk(secondSourceId);
      await fixture.sql`INSERT INTO course_asset_memberships
        (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility)
        VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${course.courseId}, 'source', ${secondSourceId}, 'core', 1, 'course')`;
      const skillLabel = "Equivalent fractions";
      const nodeId = randomUUID();
      const knowledge = createOpeningKnowledgeRepository(fixture.sql);
      const graph = await knowledge.replace(fixture.scope, course.courseId, {
        expectedVersion: 0, sourceVersions: { [course.sourceId]: 1 },
        snapshot: {
          courseId: course.courseId, version: 0,
          nodes: [{ id: nodeId, courseId: course.courseId, label: skillLabel, kind: "concept",
            evidenceChunkIds: [course.chunkId], status: "supported" }], edges: [],
        },
      });
      const { snapshots, plans } = services();
      const before = await snapshots.read(fixture.scope, { date: day, timeZone });
      expect(before.snapshot.courses.find((row) => row.courseId === course.courseId))
        .toMatchObject({ hasUsableMaterials: true, nextSkills: [skillLabel] });
      expect((await readOpeningLearnerSnapshotBase(fixture.sql, fixture.scope)).courses.find((row) => row.courseId === course.courseId))
        .toMatchObject({ knowledgeSnapshot: graph.snapshot });
      const first = (await plans.getToday(fixture.scope, day)).dailyDraft!;
      expect(first.suggestedTasks).toEqual([
        expect.objectContaining({ courseId: course.courseId, kind: "new_skill", skillLabel }),
      ]);
      expect(first.blocks).toHaveLength(1);

      if (change === "source_excluded") {
        await rows.exclude(course.sourceId);
      } else if (change === "source_version_changed") {
        await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${course.sourceId}`;
        // A is still ready with current chunks, but its old graph was built from version 1.
        await rows.chunk(course.sourceId, 2);
      } else if (change === "source_unlinked") {
        await fixture.sql`DELETE FROM course_asset_memberships
          WHERE workspace_id=${fixture.scope.workspaceId} AND course_id=${course.courseId}
            AND asset_type='source' AND asset_id=${course.sourceId}`;
      } else {
        await fixture.sql`DELETE FROM opening_source_chunks WHERE id=${course.chunkId} AND source_id=${course.sourceId}`;
        await rows.chunk(course.sourceId, 1);
      }

      const base = await readOpeningLearnerSnapshotBase(fixture.sql, fixture.scope);
      expect(base.courses.find((row) => row.courseId === course.courseId))
        .toMatchObject({ hasUsableMaterials: true, knowledgeSnapshot: null });
      expect(await knowledge.get(fixture.scope, course.courseId)).toMatchObject({
        snapshot: graph.snapshot, sourceVersions: { [course.sourceId]: 1 },
      });
      const after = await snapshots.read(fixture.scope, { date: day, timeZone });
      expect(after.sources.courses.find((row) => row.courseId === course.courseId))
        .toMatchObject({ hasUsableMaterials: true, knowledgeNodes: [] });
      expect(after.snapshot.courses.find((row) => row.courseId === course.courseId))
        .toMatchObject({ hasUsableMaterials: true, nextSkills: [] });
      await expect(plans.acceptPlan(fixture.scope, {
        draftId: first.id, expectedBaseVersion: first.baseVersion, clientKey: randomUUID(),
        acceptSuggestedKeys: [first.suggestedTasks![0]!.key],
      })).rejects.toMatchObject({ code: "CONFLICT", reason: "source_unavailable" });
      expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
      expect(await fixture.sql`SELECT status FROM opening_plan_drafts WHERE id=${first.id}`)
        .toEqual([{ status: "draft" }]);
      expect(await fixture.sql`SELECT draft_id FROM opening_plan_acceptances WHERE draft_id=${first.id}`)
        .toEqual([]);

      const refreshed = await plans.getToday(fixture.scope, day);
      const draft = refreshed.dailyDraft!;
      expect(draft.id).not.toBe(first.id);
      expect(refreshed.hasNewerSuggestion).toBeUndefined();
      expect(draft.suggestedTasks ?? []).toEqual([]);
      expect(draft.blocks).toEqual([]);
      expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
    },
  );

  it("keeps a 25-minute suggestion unscheduled when 40 free minutes are split into two 20-minute slots", async () => {
    const course = await seedCourse();
    await submitVerifiedError(course);
    await createOpeningPlanningSettingsRepository(fixture.sql).set(fixture.scope, {
      ...settings, dailyWindow: { start: "08:00", end: "09:00" }, lunch: { start: "08:20", end: "08:40" },
    });
    const draft = (await services().plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.suggestedTasks).toEqual([expect.objectContaining({ kind: "weak_skill", minutes: 25 })]);
    const suggestion = draft.suggestedTasks![0]!;
    expect(draft.blocks).toEqual([]);
    expect(draft.unscheduledTaskIds).toEqual([suggestion.id]);
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
  });

  it.each([
    { label: "zero", dailyWindow: { start: "08:00", end: "09:00" }, lunch: { start: "08:00", end: "09:00" } },
    { label: "only 20", dailyWindow: { start: "08:00", end: "08:20" }, lunch: settings.lunch },
  ])("does not invent time or tasks with $label free minutes", async ({ dailyWindow, lunch }) => {
    const course = await seedCourse();
    await submitVerifiedError(course);
    await createOpeningPlanningSettingsRepository(fixture.sql).set(fixture.scope, { ...settings, dailyWindow, lunch });
    const draft = (await services().plans.getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.suggestedTasks ?? []).toEqual([]);
    expect(draft.blocks).toEqual([]);
    expect(draft.unscheduledTaskIds).toEqual([]);
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
  });
});
