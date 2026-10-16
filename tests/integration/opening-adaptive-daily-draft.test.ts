/**
 * C2: the daily auto draft with OPENING_ADAPTIVE_PLANNING on. The learner snapshot is
 * supplied directly (G5 assembles it in production); this file covers the draft wiring.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpeningPlanningSettings, PlanningAutonomy } from "@aistudy/contracts";
import { createOpeningPlanningSettingsRepository, createOpeningPlansRepository } from "@aistudy/database";
import { ADAPTIVE_STRATEGY_VERSION, type LearnerSnapshot } from "@aistudy/domain";
import { createOpeningPlanService } from "../../apps/web/src/features/opening/planning/plan-service";
import type { LearnerSnapshotRead } from "../../apps/web/src/features/opening/planning/learner-snapshot-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const day = "2026-09-14";
const now = new Date("2026-09-14T00:30:00.000Z");
const settings: OpeningPlanningSettings = {
  weekOneMonday: "2026-09-07",
  periodTimes: { "1": { start: "08:00", end: "08:45" } },
  dailyWindow: { start: "07:30", end: "22:30" },
  lunch: { start: "12:00", end: "13:00" },
  dinner: { start: "17:30", end: "18:30" },
  sleep: { start: "23:00", end: "07:00" },
  timeZone: "Asia/Shanghai",
};

let fixture: OpeningFixture;
let courseId: string;

beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  const { sql, scope } = fixture;
  await sql`DELETE FROM opening_plan_acceptances WHERE workspace_id = ${scope.workspaceId}`;
  await sql`DELETE FROM opening_plan_drafts WHERE workspace_id = ${scope.workspaceId}`;
  await sql`DELETE FROM opening_plan_state WHERE workspace_id = ${scope.workspaceId}`;
  await sql`DELETE FROM opening_hard_blocks WHERE workspace_id = ${scope.workspaceId}`;
  await sql`DELETE FROM opening_tasks WHERE workspace_id = ${scope.workspaceId}`;
  await createOpeningPlanningSettingsRepository(sql).set(scope, settings);
  courseId = randomUUID();
  await sql`INSERT INTO courses (id, workspace_id, title, slug) VALUES (${courseId}, ${scope.workspaceId}, '线性代数', ${courseId})`;
});

function snapshot(skills: LearnerSnapshot["courses"][number]["skills"]): LearnerSnapshot {
  return {
    date: day, timeZone: settings.timeZone!, dueCardCount: 0, plannerHistory: [],
    courses: [{ courseId, title: "线性代数", skills, nextSkills: [], hasUsableMaterials: true, goal: null, minutesThisWeek: 0 }],
  };
}
const weak = () => snapshot([{ skillLabel: "矩阵乘法", status: "needs_review", lastObservedAt: "2026-09-13T10:00:00.000Z", recentAssistance: ["independent"] }]);
const read = (value: LearnerSnapshot, revision = "rev-1", autonomy: PlanningAutonomy = "copilot"): LearnerSnapshotRead => ({
  snapshot: value, sources: { date: day, timeZone: settings.timeZone!, courses: [], tasks: [], dueCardCount: 0 },
  dataStatus: { evidence: "available", goals: "available", dueCards: "available" },
  courseMaterialRevisions: { [courseId]: "unchanged-fixture-materials" },
  autonomy, plannerInputRevision: revision, metrics: { reads: 0, durationMs: 0 },
});

function service(readSnapshot: () => Promise<LearnerSnapshotRead>, enabled = true) {
  return createOpeningPlanService(fixture.sql, {
    now: () => now,
    adaptive: { enabled: () => enabled, readSnapshot },
  });
}

async function storedSnapshot(draftId: string): Promise<Record<string, unknown>> {
  const [row] = await fixture.sql`SELECT input_snapshot FROM opening_plan_drafts WHERE id = ${draftId}`;
  return row!.input_snapshot as Record<string, unknown>;
}

describe("adaptive daily draft", () => {
  it("proposes a weak-skill suggestion without creating a task", async () => {
    const today = await service(async () => read(weak())).getToday(fixture.scope, day);
    const draft = today.dailyDraft!;
    expect(draft).toMatchObject({ origin: "auto_draft", strategyVersion: ADAPTIVE_STRATEGY_VERSION });
    expect(draft.suggestedTasks).toEqual([expect.objectContaining({ kind: "weak_skill", courseId, skillLabel: "矩阵乘法" })]);
    const suggestion = draft.suggestedTasks![0]!;
    expect(suggestion.key).toMatch(new RegExp(`^planner:${day}:weak_skill:`));
    expect(draft.reasons?.[suggestion.id]).toMatchObject({ code: "weak_skill" });
    expect([...draft.blocks.map((block) => block.taskId), ...draft.unscheduledTaskIds]).toContain(suggestion.id);
    expect(await createOpeningPlansRepository(fixture.sql).listTasks(fixture.scope)).toEqual([]);
  });

  it("keeps the open draft when learning moves and replaces it only on request", async () => {
    const first = (await service(async () => read(weak())).getToday(fixture.scope, day)).dailyDraft!;
    const same = await service(async () => read(weak())).getToday(fixture.scope, day);
    expect(same.dailyDraft!.id).toBe(first.id);
    expect(same.hasNewerSuggestion).toBeUndefined();

    const moved = snapshot([{ skillLabel: "行列式", status: "needs_review", lastObservedAt: null, recentAssistance: [] }]);
    const offered = await service(async () => read(moved, "rev-2")).getToday(fixture.scope, day);
    expect(offered.dailyDraft!.id).toBe(first.id);
    expect(offered.hasNewerSuggestion).toBe(true);

    const refreshed = await service(async () => read(moved, "rev-2")).getToday(fixture.scope, day, { refreshSuggestions: true });
    expect(refreshed.dailyDraft!.id).not.toBe(first.id);
    expect(refreshed.dailyDraft!.suggestedTasks?.map((task) => task.skillLabel)).toEqual(["行列式"]);
    expect(refreshed.hasNewerSuggestion).toBeUndefined();
  });

  it("falls back to the rule draft and records why when the snapshot cannot be read", async () => {
    const onSnapshotFailure = vi.fn();
    const today = await createOpeningPlanService(fixture.sql, {
      now: () => now,
      adaptive: { enabled: () => true, readSnapshot: async () => { throw new Error("evidence down"); }, onSnapshotFailure },
    }).getToday(fixture.scope, day);
    const draft = today.dailyDraft!;
    expect(draft.origin).toBeUndefined();
    expect(draft.suggestedTasks).toBeUndefined();
    expect(await storedSnapshot(draft.id)).toMatchObject({ adaptiveFallback: "snapshot_unavailable" });
    expect(onSnapshotFailure).toHaveBeenCalledOnce();
  });

  it("proposes nothing in manual mode", async () => {
    const draft = (await service(async () => read(weak(), "rev-1", "manual")).getToday(fixture.scope, day)).dailyDraft!;
    expect(draft.suggestedTasks).toBeUndefined();
    expect(draft.strategyVersion).toBe(ADAPTIVE_STRATEGY_VERSION);
  });

  it("leaves the rule draft untouched while the switch is off and rebuilds when it turns on", async () => {
    const readSnapshot = vi.fn(async () => read(weak()));
    const off = (await service(readSnapshot, false).getToday(fixture.scope, day)).dailyDraft!;
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(off).not.toHaveProperty("origin");
    expect(off).not.toHaveProperty("suggestedTasks");
    expect(off).not.toHaveProperty("strategyVersion");

    const on = (await service(readSnapshot, true).getToday(fixture.scope, day)).dailyDraft!;
    expect(on.id).not.toBe(off.id);
    expect(on.suggestedTasks).toHaveLength(1);
  });
});
