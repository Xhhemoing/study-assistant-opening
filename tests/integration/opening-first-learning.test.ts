import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningPlanningSettingsRepository } from "@aistudy/database";
import { createOpeningTeachingActivityService } from "../../apps/web/src/features/opening/teaching/activity-service";
import { createOpeningPlanService } from "../../apps/web/src/features/opening/planning/plan-service";
import { startFirstLearning } from "../../apps/web/src/features/workspace/first-learning-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
function setup() {
  const now = new Date();
  const input = { clientKey: randomUUID(), topic: "矩阵的几何意义", goal: "能用二维变换解释矩阵乘法",
    targetDate: null, minutes: 30, startTime: "19:00", timeZone: "Asia/Shanghai", sourceIds: [] };
  const deps = { activities: createOpeningTeachingActivityService(fixture.sql, {}),
    plans: createOpeningPlanService(fixture.sql), settings: createOpeningPlanningSettingsRepository(fixture.sql), now: () => now };
  return { input, deps };
}
describe("first-learning persistence and recovery", () => {
  it("replays one real activity and task without accepting a plan or recording an assessment", async () => {
    const { deps, input } = setup();
    const first = await startFirstLearning(deps, fixture.scope, input);
    const replay = await startFirstLearning(deps, fixture.scope, input);
    expect(replay.activityId).toBe(first.activityId);
    expect(replay.taskId).toBe(first.taskId);
    const [activity] = await fixture.sql`SELECT intent_summary,goal_json,content_version FROM opening_teaching_activities WHERE id=${first.activityId}`;
    expect(activity!.intent_summary).toContain(input.goal);
    expect(activity!.goal_json.learningGoal).toBe(input.goal);
    expect(activity!.content_version).toBe(0);
    const [task] = await fixture.sql`SELECT status,minutes FROM opening_tasks WHERE id=${first.taskId}`;
    expect(task).toMatchObject({ status: "pending", minutes: 30 });
    const resumedFromTask = await deps.activities.create(fixture.scope, { clientKey: `task:${first.taskId}`,
      intentKind: "goal", intentSummary: "client title ignored", createIntent: { source: "task", taskId: first.taskId } });
    expect(resumedFromTask.id).toBe(first.activityId);
    expect(resumedFromTask.intentSummary).toContain(input.goal);
    const plan = await deps.plans.getToday(fixture.scope, first.planDate);
    expect(plan.acceptedVersion).toBe(0);
    const [counts] = await fixture.sql`SELECT count(*)::int AS count FROM opening_learning_observations WHERE workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}`;
    expect(counts!.count).toBe(0);
  });
  it("can resume after an actual activity and task committed but schedule initialization failed", async () => {
    const { deps, input } = setup();
    // Use the untouched workspace so this run reaches conditional initialization.
    const original = deps.settings.initialize;
    let fail = true;
    deps.settings.initialize = async (...args) => {
      if (fail) { fail = false; throw new Error("injected initialization failure"); }
      return original(...args);
    };
    await expect(startFirstLearning(deps, fixture.otherScope, input)).rejects.toThrow("injected initialization failure");
    const resumed = await startFirstLearning(deps, fixture.otherScope, input);
    const [counts] = await fixture.sql`SELECT
      (SELECT count(*)::int FROM opening_teaching_activities WHERE workspace_id=${fixture.otherScope.workspaceId} AND client_key=${`first-learning:${input.clientKey}:activity`}) AS activities,
      (SELECT count(*)::int FROM opening_tasks WHERE workspace_id=${fixture.otherScope.workspaceId} AND client_key=${`first-learning-activity:${resumed.activityId}`}) AS tasks`;
    expect(counts).toMatchObject({ activities: 1, tasks: 1 });
    expect(resumed.scheduleInitialized).toBe(true);
    expect((await deps.settings.get(fixture.otherScope)).settings?.dailyWindow).toEqual({ start: "19:00", end: "19:30" });
  });
  it("rejects a nonexistent material without creating a pending task", async () => {
    const { deps, input } = setup();
    await expect(startFirstLearning(deps, fixture.scope, { ...input, sourceIds: [randomUUID()] })).rejects.toThrow();
    const [counts] = await fixture.sql`SELECT count(*)::int AS count FROM opening_teaching_activities WHERE workspace_id=${fixture.scope.workspaceId} AND client_key=${`first-learning:${input.clientKey}:activity`}`;
    expect(counts!.count).toBe(0);
  });
  it("recovers an existing intent across midnight but cannot create a new intent with a past target", async () => {
    const { deps, input } = setup();
    deps.now = () => new Date("2026-10-19T15:59:00Z");
    const sameDay = { ...input, targetDate: "2026-10-19" };
    const first = await startFirstLearning(deps, fixture.scope, sameDay);
    deps.now = () => new Date("2026-10-19T16:01:00Z");
    expect((await startFirstLearning(deps, fixture.scope, sameDay)).activityId).toBe(first.activityId);
    const otherKey = randomUUID();
    await expect(startFirstLearning(deps, fixture.scope, { ...sameDay, clientKey: otherKey })).rejects.toThrow();
    const [count] = await fixture.sql`SELECT count(*)::int AS count FROM opening_teaching_activities WHERE workspace_id=${fixture.scope.workspaceId} AND client_key=${`first-learning:${otherKey}:activity`}`;
    expect(count!.count).toBe(0);
  });
});
