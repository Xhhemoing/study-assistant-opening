/** Real SQL evidence → learner snapshot → Today draft; C3 acceptance is covered separately. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpeningPlanningSettings, PlanDraft } from "@aistudy/contracts";
import {
  createOpeningAdaptivePrefsRepository,
  createOpeningPlanningSettingsRepository,
  createOpeningPlansRepository,
} from "@aistudy/database";
import { ADAPTIVE_STRATEGY_VERSION, addLocalDays, suggestionIdentity, suggestionKey } from "@aistudy/domain";
import { createOpeningPlanService } from "../../apps/web/src/features/opening/planning/plan-service";
import { createSqlLearnerSnapshotService } from "../../apps/web/src/features/opening/planning/learner-snapshot-runtime";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

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

async function submitVerifiedError(course: AttemptFixture) {
  return course.submit(await course.start(), {
    answer: "2", outcome: "incorrect", verdictSource: "reference_checked", referenceSourceId: course.sourceId,
    referenceCheck: { referenceSourceId: course.sourceId, method: "Compared against the reference solution", scope: "whole_answer" },
  });
}

function services(enabled = true) {
  const snapshots = createSqlLearnerSnapshotService(fixture.sql, { now: () => now });
  const readSnapshot = vi.fn(snapshots.read);
  const plans = createOpeningPlanService(fixture.sql, {
    now: () => now,
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
