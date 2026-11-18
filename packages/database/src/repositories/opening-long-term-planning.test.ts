import { expect, it, vi } from "vitest";
import type { Sql } from "postgres";

const mocks = vi.hoisted(() => ({
  agenda: null as Record<string, unknown> | null,
  recoveryActivity: null as { activityId: string; sessionId: string | null; courseId: string } | null,
  tasks: [] as Record<string, unknown>[],
  activityRow: null as Record<string, unknown> | null,
}));

vi.mock("./opening-learning-agenda", () => ({
  readOpeningLearningAgenda: vi.fn(async () => mocks.agenda),
}));
vi.mock("./opening-current-learning-activity", () => ({
  readOpeningCurrentLearningRecovery: vi.fn(async () => mocks.recoveryActivity),
}));
vi.mock("./opening-learning-capacity", () => ({
  readOpeningLearningCapacity: vi.fn(async () => ({
    localDate: "2026-11-02", timeZone: "UTC", budget: { dailyMinutes: 60, bufferMinutes: 0, revision: 1, updatedAt: "2026-11-02T00:00:00Z" },
    settings: null, bounds: { dayStart: new Date("2026-11-02T00:00:00Z"), nextDayStart: new Date("2026-11-03T00:00:00Z") },
    activities: [], tasks: [], blocks: [], usedMinutes: 0,
  })),
  reserveOpeningLearningActivityBudget: vi.fn(),
}));
vi.mock("./opening-learning-goals", () => ({
  readLearningGoals: vi.fn(async () => []),
  updateLearningGoalInTx: vi.fn(),
}));
vi.mock("./opening-long-term-card-session", () => ({
  readLearningCardSessions: vi.fn(async () => []),
}));
vi.mock("./opening-span-tutor-origin", () => ({
  readOpeningSpanTutorOriginChange: vi.fn(async () => null),
}));
vi.mock("./opening-plans", () => ({
  createOpeningPlansRepository: () => ({
    getToday: vi.fn(async () => null),
    listTasks: vi.fn(async () => mocks.tasks),
  }),
  dailyDraftAdvisoryLockKeys: () => [1, 2],
  mapOpeningPlanDraft: vi.fn(),
}));
vi.mock("./opening-learning-facts", async original => {
  const mod = await original<typeof import("./opening-learning-facts")>();
  return { ...mod, lockWorkspaceLearningHistory: vi.fn(async () => undefined) };
});

import { readOpeningLearningAgenda } from "./opening-learning-agenda";
import { createOpeningLongTermPlanningRepository, selectLearningRecoveryTask } from "./opening-long-term-planning";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const courseId = "33333333-3333-4333-8333-333333333333";
const activityId = "44444444-4444-4444-8444-444444444444";
const taskId = "55555555-5555-4555-8555-555555555555";

function createFakeSql() {
  const exec = (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId }]);
    if (query.includes("FROM opening_tasks")) return Promise.resolve([]);
    if (query.includes("FROM opening_teaching_activities") && query.includes("client_key IN")) return Promise.resolve([]);
    if (query.includes("FROM opening_teaching_activities")) return Promise.resolve(mocks.activityRow ? [mocks.activityRow] : []);
    return Promise.resolve([]);
  };
  const tx = Object.assign(exec, {
    json: (v: unknown) => v,
    savepoint: (fn: (nested: unknown) => Promise<unknown>) => fn(tx),
  });
  return {
    begin: (_modeOrFn: unknown, maybeFn?: (tx: unknown) => Promise<unknown>) => (maybeFn ?? (_modeOrFn as (tx: unknown) => Promise<unknown>))(tx),
  } as unknown as Sql;
}

it("never attaches another course's first pending task to the current activity", () => {
  const tasks = [{ id: "b", status: "pending", courseId: "course-b" }, { id: "a", status: "pending", courseId: "course-a" }];
  expect(selectLearningRecoveryTask(tasks as never, { id: "activity-a", course_id: "course-a", create_intent: {} })).toBeUndefined();
  expect(selectLearningRecoveryTask(tasks as never, { id: "activity-a", course_id: "course-a", create_intent: { source: "task", taskId: "a" } })?.id).toBe("a");
});

it.each([
  { status: "deferred", reason: "retest_deferred" },
  { status: "cancelled", reason: "retest_cancelled_or_unavailable" },
  { status: "completed", reason: "retest_completed" },
] as const)(
  "returns null recovery href even with a linked task and blocks both continue and shorten when agenda is non-resumable (%s)",
  async ({ status, reason }) => {
    mocks.activityRow = {
      id: activityId, course_id: courseId, status: "active",
      create_intent: { protocol: "span-lesson-v1", source: "task", taskId },
      checkpoint_json: { spanLesson: { sessionId: activityId, retestId: "66666666-6666-4666-8666-666666666666" } },
      goal_json: {},
    };
    mocks.recoveryActivity = { activityId, sessionId: activityId, courseId };
    mocks.tasks = [{
      id: taskId, courseId, title: "延迟复测",
      minutes: 20, dueAt: null, priority: 1, status: "pending", origin: "retest", version: 1,
    }];
    mocks.agenda = {
      courseId, goalId: null, activityId, sessionId: activityId, itemVersionId: null,
      status, mode: "diagnose", userOverride: null, help: { delivered: false, level: "none" },
      requirement: "span-v1", selectedAction: null, returnTo: null, originActivityId: null,
      pendingRetestId: null, parentDecisionId: null, decisionCurrent: true,
      invalidationReasons: [reason], intent: null, moveId: "self-example",
      budget: null, decisionId: null, resumable: false, suggestion: null,
      dataAsOf: "2026-11-02T09:00:00.000Z",
    };

    const repo = createOpeningLongTermPlanningRepository(createFakeSql(), () => new Date("2026-11-02T09:00:00Z"));
    const overview = await repo.read(scope, "2026-11-02");
    expect(overview.recovery.activityId).toBe(activityId);
    expect(overview.recovery.taskId).toBe(taskId);
    expect(overview.recovery.href).toBeNull();
    expect(overview.recovery.agenda?.resumable).toBe(false);

    await expect(repo.recover(scope, {
      action: "continue", date: "2026-11-02", activityId, taskId: null,
      expectedAcceptedVersion: 0, expectedBudgetRevision: 1, clientKey: "recovery-continue-key-1",
    })).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(repo.recover(scope, {
      action: "shorten", date: "2026-11-02", activityId, taskId: null, minutes: 10,
      expectedAcceptedVersion: 0, expectedBudgetRevision: 1, clientKey: "recovery-shorten-key-1",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  },
);

it("forwards injected clock to readOpeningLearningAgenda in both overview read and recover", async () => {
  const agendaMock = vi.mocked(readOpeningLearningAgenda);
  agendaMock.mockClear();

  const snoozedUntil = Date.parse("2026-11-05T09:00:00Z");
  let current = new Date("2026-11-02T09:00:00Z");
  mocks.activityRow = {
    id: activityId, course_id: courseId, status: "active",
    create_intent: { protocol: "span-lesson-v1", source: "task", taskId },
    checkpoint_json: { spanLesson: { sessionId: activityId, retestId: "66666666-6666-4666-8666-666666666666" } },
    goal_json: {},
  };
  mocks.recoveryActivity = { activityId, sessionId: activityId, courseId };
  mocks.tasks = [];
  agendaMock.mockImplementation(async (_tx, _scope, _courseId, _activityId, options) => {
    const deferred = (options?.now?.getTime() ?? Date.now()) < snoozedUntil;
    return {
      courseId, goalId: null, activityId, sessionId: activityId, itemVersionId: null,
      status: deferred ? "deferred" : "active", mode: "diagnose", userOverride: null,
      help: { delivered: false, level: "none" }, requirement: "span-v1", selectedAction: null,
      returnTo: null, originActivityId: null, pendingRetestId: null, parentDecisionId: null,
      decisionCurrent: true, invalidationReasons: deferred ? ["retest_deferred"] : [],
      intent: null, moveId: "self-example", budget: null, decisionId: null,
      resumable: !deferred, suggestion: null, dataAsOf: (options?.now ?? current).toISOString(),
    };
  });

  const repo = createOpeningLongTermPlanningRepository(createFakeSql(), () => current);
  const before = await repo.read(scope, "2026-11-02");
  expect(before.recovery.href).toBeNull();
  expect(before.recovery.agenda).toMatchObject({ status: "deferred", resumable: false });
  expect(agendaMock).toHaveBeenLastCalledWith(expect.anything(), scope, courseId, activityId, { now: new Date("2026-11-02T09:00:00Z") });

  await expect(repo.recover(scope, {
    action: "continue", date: "2026-11-02", activityId, taskId: null,
    expectedAcceptedVersion: 0, expectedBudgetRevision: 1, clientKey: "recovery-clock-before",
  })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(agendaMock).toHaveBeenLastCalledWith(expect.anything(), scope, courseId, activityId, { now: new Date("2026-11-02T09:00:00Z") });

  current = new Date("2026-11-05T09:00:00Z");
  const atBoundary = await repo.read(scope, "2026-11-05");
  expect(atBoundary.recovery.href).toBe(`/opening/courses/${courseId}/study/span?lesson=${activityId}&retest=66666666-6666-4666-8666-666666666666`);
  expect(atBoundary.recovery.agenda).toMatchObject({ status: "active", resumable: true });
  expect(agendaMock).toHaveBeenLastCalledWith(expect.anything(), scope, courseId, activityId, { now: new Date("2026-11-05T09:00:00Z") });

  await expect(repo.recover(scope, {
    action: "continue", date: "2026-11-05", activityId, taskId: null,
    expectedAcceptedVersion: 0, expectedBudgetRevision: 1, clientKey: "recovery-clock-at",
  })).resolves.toMatchObject({ activityId, taskId: null });
  expect(agendaMock).toHaveBeenLastCalledWith(expect.anything(), scope, courseId, activityId, { now: new Date("2026-11-05T09:00:00Z") });
});
