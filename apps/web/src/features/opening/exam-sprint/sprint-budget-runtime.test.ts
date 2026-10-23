import type { Sql } from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OPENING_PLANNING_SETTINGS,
  type OpeningAdaptivePrefsResponse, type OpeningPlanningSettingsResponse, type PlannedBlock, type TaskItem,
} from "@aistudy/contracts";

const deps = vi.hoisted(() => ({
  learningFactory: vi.fn(), prefsFactory: vi.fn(), settingsFactory: vi.fn(), plansFactory: vi.fn(),
  assertOwnedCourse: vi.fn(), preferences: vi.fn(), settings: vi.fn(),
  listTasks: vi.fn(), listTimetable: vi.fn(), getToday: vi.fn(), listHardBlocks: vi.fn(), write: vi.fn(),
}));
vi.mock("@aistudy/database", () => ({
  createOpeningLearningRepository: deps.learningFactory,
  createOpeningAdaptivePrefsRepository: deps.prefsFactory,
  createOpeningPlanningSettingsRepository: deps.settingsFactory,
  createOpeningPlansRepository: deps.plansFactory,
}));

import { getSprintBudgetService } from "./sprint-budget-runtime";

const courseId = "a1111111-1111-4111-8111-111111111111";
const taskId = "44444444-4444-4444-8444-444444444444";
const otherTaskId = "55555555-5555-4555-8555-555555555555";
const otherCourseId = "66666666-6666-4666-8666-666666666666";
const scope = { workspaceId: "22222222-2222-4222-8222-222222222222", ownerUserId: "33333333-3333-4333-8333-333333333333" };
const now = "2026-10-23T08:00:00.000Z";
const tasks: TaskItem[] = [
  { id: taskId, title: "订正已保存的极限题", minutes: 30, dueAt: null, priority: 1, status: "pending", courseId, origin: "retest" },
  { id: otherTaskId, title: "另一门课", minutes: 15, dueAt: null, priority: 1, status: "pending", courseId: otherCourseId },
];
const accepted: PlannedBlock[] = [{ taskId: otherTaskId, start: "2026-10-23T09:00:00.000Z", end: "2026-10-23T09:15:00.000Z", reason: "已确认" }];
function preferences(): OpeningAdaptivePrefsResponse {
  return { prefs: { autonomy: "coach", coachBudgetMinutes: 60, coachAutoAcceptEnabled: true,
    courseGoals: { [courseId]: { targetDate: "2026-10-24", weeklyMinutes: 420 } } }, saved: true, invalidStoredPrefs: false };
}
function settings(): OpeningPlanningSettingsResponse {
  return { settings: { ...DEFAULT_OPENING_PLANNING_SETTINGS, weekOneMonday: "2026-10-19",
    timeZone: "UTC", dailyWindow: { start: "09:00", end: "10:00" } }, saved: true, invalidStoredSettings: false };
}

type Query = { text: string; values: unknown[] };
function transactionHarness(answer: (query: Query) => unknown[] = () => { throw new Error("unexpected SQL from mocked repository"); }) {
  const queries: Query[] = [];
  const events: string[] = [];
  const writes: Query[] = [];
  const forbidden = vi.fn(() => { throw new Error("unexpected mutation or nested transaction"); });
  const tx = Object.assign(vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?").replace(/\s+/g, " ").trim(), values };
    queries.push(query);
    if (!/^SELECT\b/i.test(query.text) || /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP)\b|pg_advisory/i.test(query.text)) {
      writes.push(query);
      throw new Error(`non-read SQL: ${query.text}`);
    }
    return answer(query);
  }), { begin: forbidden, unsafe: forbidden, json: forbidden });
  const begin = vi.fn(async (options: string, run: (transaction: Sql) => Promise<unknown>) => {
    events.push(`begin:${options}`);
    try {
      const result = await run(tx as unknown as Sql);
      events.push("commit");
      return result;
    } catch (error) {
      events.push("rollback");
      throw error;
    }
  });
  const root = Object.assign(vi.fn(() => { throw new Error("query escaped the snapshot transaction"); }), { begin, unsafe: forbidden });
  return { sql: root as unknown as Sql, root, tx, begin, queries, events, writes, forbidden };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  deps.write.mockImplementation(() => { throw new Error("preview attempted a write"); });
  deps.assertOwnedCourse.mockResolvedValue(undefined);
  deps.preferences.mockResolvedValue(preferences());
  deps.settings.mockResolvedValue(settings());
  deps.listTasks.mockResolvedValue(structuredClone(tasks));
  deps.listTimetable.mockResolvedValue([]);
  deps.getToday.mockResolvedValue({ acceptedVersion: 1, blocks: accepted, hardBlocksFingerprint: "existing" });
  deps.listHardBlocks.mockResolvedValue([{ start: "2026-10-23T09:15:00.000Z", end: "2026-10-23T09:30:00.000Z", kind: "locked" }]);
  deps.learningFactory.mockReturnValue({ assertOwnedCourse: deps.assertOwnedCourse, createSession: deps.write });
  deps.prefsFactory.mockReturnValue({ get: deps.preferences, patch: deps.write });
  deps.settingsFactory.mockReturnValue({ get: deps.settings, set: deps.write, initialize: deps.write });
  deps.plansFactory.mockReturnValue({
    listTasks: deps.listTasks, listTimetable: deps.listTimetable,
    getToday: deps.getToday, listHardBlocks: deps.listHardBlocks,
    ensureAutoDraft: deps.write, proposePlan: deps.write, acceptPlan: deps.write, createTask: deps.write,
    updateTaskStatus: deps.write, upsertHardBlocks: deps.write, replaceTimetable: deps.write,
  });
});
afterEach(() => {
  vi.useRealTimers();
  expect(deps.write).not.toHaveBeenCalled();
});

describe("sprint budget runtime with repository doubles", () => {
  it("uses the actual service and one repeatable-read/read-only transaction for every repository", async () => {
    const db = transactionHarness();
    const service = getSprintBudgetService(db.sql);
    expect(db.begin).not.toHaveBeenCalled();
    const result = await service.read(scope, courseId);
    expect(db.begin).toHaveBeenCalledExactlyOnceWith("isolation level repeatable read read only", expect.any(Function));
    for (const factory of [deps.learningFactory, deps.prefsFactory, deps.settingsFactory, deps.plansFactory]) {
      expect(factory).toHaveBeenCalledExactlyOnceWith(db.tx);
    }
    expect(deps.assertOwnedCourse).toHaveBeenCalledExactlyOnceWith(scope, courseId);
    for (const read of [deps.preferences, deps.settings, deps.listTasks, deps.listTimetable]) expect(read).toHaveBeenCalledExactlyOnceWith(scope);
    expect(deps.getToday).toHaveBeenCalledExactlyOnceWith(scope, "2026-10-23");
    expect(deps.listHardBlocks).toHaveBeenCalledExactlyOnceWith(scope, "2026-10-23");
    expect(result).toMatchObject({ status: "ready", generatedAt: now, tasks: [{ id: taskId, title: tasks[0]!.title }], scheduledTaskIds: [taskId] });
    expect(result.days[0]?.blocks).toEqual([expect.objectContaining({ taskId, start: "2026-10-23T09:30:00.000Z", end: "2026-10-23T10:00:00.000Z" })]);
    expect(db.events).toEqual(["begin:isolation level repeatable read read only", "commit"]);
    expect(db.root).not.toHaveBeenCalled();
    expect(db.tx).not.toHaveBeenCalled();
    expect(db.forbidden).not.toHaveBeenCalled();
  });

  it("treats a missing accepted plan as empty, and never asks the planning service to create one", async () => {
    deps.getToday.mockResolvedValue(null);
    deps.listHardBlocks.mockResolvedValue([]);
    const db = transactionHarness();
    const result = await getSprintBudgetService(db.sql).read(scope, courseId);
    expect(result.days[0]?.blocks).toEqual([expect.objectContaining({ taskId, start: "2026-10-23T09:00:00.000Z" })]);
    expect(db.events.at(-1)).toBe("commit");
  });

  it("does not read preferences, settings or plans before course ownership resolves", async () => {
    let allow!: () => void;
    deps.assertOwnedCourse.mockReturnValue(new Promise<void>(resolve => { allow = resolve; }));
    const db = transactionHarness();
    const pending = getSprintBudgetService(db.sql).read(scope, courseId);
    expect(deps.assertOwnedCourse).toHaveBeenCalledOnce();
    for (const read of [deps.preferences, deps.settings, deps.listTasks, deps.listTimetable, deps.getToday, deps.listHardBlocks]) expect(read).not.toHaveBeenCalled();
    allow();
    await pending;
    expect(db.events.at(-1)).toBe("commit");
  });

  it.each(["ownership", "day"])("propagates a %s failure out of the snapshot without fallback or partial success", async stage => {
    const failure = new Error("snapshot read failed");
    (stage === "ownership" ? deps.assertOwnedCourse : deps.listHardBlocks).mockRejectedValue(failure);
    const db = transactionHarness();
    await expect(getSprintBudgetService(db.sql).read(scope, courseId)).rejects.toBe(failure);
    expect(db.events).toEqual(["begin:isolation level repeatable read read only", "rollback"]);
    expect(db.begin).toHaveBeenCalledOnce();
    if (stage === "ownership") {
      for (const read of [deps.preferences, deps.settings, deps.listTasks, deps.listTimetable, deps.getToday, deps.listHardBlocks]) expect(read).not.toHaveBeenCalled();
    }
    expect(db.root).not.toHaveBeenCalled();
    expect(db.forbidden).not.toHaveBeenCalled();
  });
});

// Exercise production repository factories too; the fake is only the tagged SQL
// transport. No database client, migrations, app runtime, or model is started.
async function useRealRepositories() {
  const [learning, prefs, planningSettings, plans] = await Promise.all([
    import("../../../../../../packages/database/src/repositories/opening-learning"),
    import("../../../../../../packages/database/src/repositories/opening-adaptive-prefs"),
    import("../../../../../../packages/database/src/repositories/opening-planning-settings"),
    import("../../../../../../packages/database/src/repositories/opening-plans"),
  ]);
  deps.learningFactory.mockImplementation(learning.createOpeningLearningRepository);
  deps.prefsFactory.mockImplementation(prefs.createOpeningAdaptivePrefsRepository);
  deps.settingsFactory.mockImplementation(planningSettings.createOpeningPlanningSettingsRepository);
  deps.plansFactory.mockImplementation(plans.createOpeningPlansRepository);
}
function storedReader(overrides: { owned?: boolean; prefs?: unknown; settings?: unknown } = {}) {
  const stored = {
    prefs: "prefs" in overrides ? overrides.prefs : preferences().prefs,
    settings: "settings" in overrides ? overrides.settings : settings().settings,
    tasks: tasks.map(task => ({ id: task.id, title: task.title, minutes: task.minutes, priority: task.priority,
      status: task.status, course_id: task.courseId, version: 1, due_at: null, origin: task.origin })),
    accepted: structuredClone(accepted),
    hard: [{ start_at: new Date("2026-10-23T09:15:00Z"), end_at: new Date("2026-10-23T09:30:00Z"), kind: "locked" }],
  };
  const before = structuredClone(stored);
  const db = transactionHarness(({ text, values }) => {
    if (text.includes("FROM courses c")) {
      expect(values).toEqual([courseId, scope.workspaceId, scope.ownerUserId]);
      expect(text).toContain("c.archived_at IS NULL");
      return overrides.owned === false ? [] : [{ id: courseId }];
    }
    if (text.includes("p.adaptive_planning FROM workspaces")) return [{ adaptive_planning: stored.prefs }];
    if (text.includes("p.planning_settings FROM workspaces")) return [{ planning_settings: stored.settings }];
    if (text.includes("FROM opening_tasks t")) return stored.tasks;
    if (text.includes("FROM opening_timetable_sessions")) return [];
    if (text.includes("FROM opening_plan_state")) {
      expect(values).toEqual([scope.workspaceId, "2026-10-23"]);
      return [{ accepted_version: 1, accepted_blocks: stored.accepted, hard_blocks_fingerprint: "saved" }];
    }
    if (text.includes("FROM opening_hard_blocks")) {
      expect(values).toEqual([scope.workspaceId, scope.ownerUserId, "2026-10-23"]);
      return stored.hard;
    }
    throw new Error(`unexpected query: ${text}`);
  });
  return { ...db, stored, before };
}

describe("sprint budget production factory wiring with tagged-SQL fake", () => {
  it("maps persisted rows through the real repositories, reserves existing blocks, and issues SELECTs only", async () => {
    await useRealRepositories();
    const db = storedReader();
    const result = await getSprintBudgetService(db.sql).read(scope, courseId);
    expect(result).toMatchObject({ status: "ready", scheduledTaskIds: [taskId], tasks: [{ id: taskId, title: tasks[0]!.title }] });
    expect(result.days[0]?.blocks).toEqual([expect.objectContaining({ taskId, start: "2026-10-23T09:30:00.000Z", end: "2026-10-23T10:00:00.000Z" })]);
    expect(db.queries).toHaveLength(7);
    expect(db.queries[0]?.text).toContain("FROM courses c");
    for (const query of db.queries) {
      expect(query.values).toContain(scope.workspaceId);
      if (!query.text.includes("FROM opening_plan_state")) expect(query.values).toContain(scope.ownerUserId);
    }
    for (const factory of [deps.learningFactory, deps.prefsFactory, deps.settingsFactory, deps.plansFactory]) expect(factory).toHaveBeenCalledExactlyOnceWith(db.tx);
    expect(db.events).toEqual(["begin:isolation level repeatable read read only", "commit"]);
    expect(db.stored).toEqual(db.before);
    expect(db.writes).toEqual([]);
    expect(db.root).not.toHaveBeenCalled();
    expect(db.forbidden).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing preferences", prefs: null, status: "needs_goal" },
    { label: "corrupt preferences", prefs: { courseGoals: "broken" }, status: "invalid_settings" },
    { label: "missing settings", settings: null, status: "needs_settings" },
    { label: "corrupt settings", settings: { timeZone: "UTC" }, status: "invalid_settings" },
  ])("keeps $label read-only instead of initializing or repairing persisted documents", async fixture => {
    await useRealRepositories();
    const db = storedReader(fixture);
    const result = await getSprintBudgetService(db.sql).read(scope, courseId);
    expect(result).toMatchObject({ status: fixture.status, days: [], tasks: [], scheduledTaskIds: [] });
    expect(db.queries).toHaveLength(3);
    expect(db.events.at(-1)).toBe("commit");
    expect(db.stored).toEqual(db.before);
    expect(db.writes).toEqual([]);
    expect(db.forbidden).not.toHaveBeenCalled();
    expect(db.root).not.toHaveBeenCalled();
  });

  it("lets the real ownership repository reject a foreign/archived course before any other SELECT", async () => {
    await useRealRepositories();
    const db = storedReader({ owned: false });
    await expect(getSprintBudgetService(db.sql).read(scope, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.queries).toHaveLength(1);
    expect(deps.prefsFactory).not.toHaveBeenCalled();
    expect(deps.settingsFactory).not.toHaveBeenCalled();
    expect(db.events.at(-1)).toBe("rollback");
    expect(db.writes).toEqual([]);
    expect(db.stored).toEqual(db.before);
  });
});
