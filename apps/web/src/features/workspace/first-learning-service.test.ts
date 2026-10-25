import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_PLANNING_SETTINGS, type TeachingActivity } from "@aistudy/contracts";
import { startFirstLearning, type FirstLearningDependencies } from "./first-learning-service";
import { ApiError } from "../auth/service";

const id = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: id, ownerUserId: id };
const input = { clientKey: id, topic: "线性代数", goal: "解释矩阵的几何意义", targetDate: "2026-11-01",
  minutes: 30, startTime: "19:00", timeZone: "Asia/Shanghai", sourceIds: [id] };
function setup() {
  const activity: TeachingActivity = { id, workspaceId: id, ownerUserId: id, courseId: id, status: "active",
    generateStatus: "queued", intentKind: "goal", intentSummary: input.topic, sourceIds: [id],
    pathVersion: 1, contentVersion: 0, clientKey: id, createdAt: "2026-10-19T10:30:00Z", updatedAt: "2026-10-19T10:30:00Z" };
  const task = { id, title: input.topic, minutes: 30, dueAt: null, priority: 1, status: "pending" as const };
  const initialized = { activity, courseId: id, tasks: [task], firstTaskId: id, startDate: "2026-10-19",
    endDate: "2026-10-31", replayed: false, legacy: false };
  const deps = {
    firstLearning: { initialize: vi.fn<FirstLearningDependencies["firstLearning"]["initialize"]>(async (_scope, _input, options) => {
      if (options?.replayOnly) throw new ApiError("VALIDATION", "past new request", 400);
      return initialized;
    }) },
    plans: { createTaskWithOutcome: vi.fn<FirstLearningDependencies["plans"]["createTaskWithOutcome"]>(async () => ({ task, replayed: false })),
      getToday: vi.fn(async () => ({ date: "2026-10-19", acceptedVersion: 0, blocks: [], hardBlocks: [], dailyDraft: null, dailyDraftSkippedReason: null })) },
    settings: { get: vi.fn<FirstLearningDependencies["settings"]["get"]>(async () => ({ settings: null, saved: false, invalidStoredSettings: false })),
      initialize: vi.fn<FirstLearningDependencies["settings"]["initialize"]>(async () => true), set: vi.fn() },
    now: () => new Date("2026-10-19T10:30:00Z") };
  return { deps: deps as FirstLearningDependencies, calls: deps, initialized };
}
describe("first learning", () => {
  it("initializes the course and dated tasks before requesting today's unaccepted plan", async () => {
    const { deps, calls } = setup();
    await expect(startFirstLearning(deps, scope, input)).resolves.toMatchObject({ activityId: id, taskId: id, courseId: id, planDate: "2026-10-19", generateStatus: "queued", href: `/opening/courses/${id}/study?activity=${id}` });
    expect(calls.firstLearning.initialize).toHaveBeenCalledWith(scope, expect.objectContaining({
      intent: input, startDate: "2026-10-19", planTimeZone: "Asia/Shanghai",
      days: expect.arrayContaining([expect.objectContaining({ date: "2026-10-19", minutes: 30 })]),
    }), { replayOnly: false });
    expect(calls.plans.createTaskWithOutcome).not.toHaveBeenCalled();
    expect(calls.settings.initialize).toHaveBeenCalledWith(scope, expect.objectContaining({ weekOneMonday: "2026-10-19", dailyWindow: { start: "19:00", end: "19:30" } }));
    expect(calls.plans.getToday).toHaveBeenCalledWith(scope, "2026-10-19");
  });
  it.each([{ ...input, topic: "  " }, { ...input, targetDate: "2026-02-30" },
    { ...input, startTime: "23:50" }, { ...input, timeZone: "fake/zone" }, { ...input, ownerUserId: id }])("rejects invalid or forged input before writes", async raw => {
    const { deps, calls } = setup();
    await expect(startFirstLearning(deps, scope, raw)).rejects.toThrow();
    expect(calls.firstLearning.initialize).not.toHaveBeenCalled();
    expect(calls.settings.initialize).not.toHaveBeenCalled();
  });
  it("allows only an existing intent to recover after its target date and uses the saved plan origin", async () => {
    const { deps, calls, initialized } = setup();
    calls.settings.initialize.mockRejectedValueOnce(new Error("connection lost"));
    const sameDay = { ...input, targetDate: "2026-10-19" };
    await expect(startFirstLearning(deps, scope, sameDay)).rejects.toThrow("connection lost");
    calls.firstLearning.initialize.mockResolvedValueOnce({ ...initialized, replayed: true });
    deps.now = () => new Date("2026-10-26T00:30:00Z");
    await startFirstLearning(deps, scope, sameDay);
    expect(calls.firstLearning.initialize.mock.calls[1]![2]).toEqual({ replayOnly: true });
    expect(calls.settings.initialize.mock.calls[1]![1].weekOneMonday).toBe("2026-10-19");
    await expect(startFirstLearning(deps, scope, { ...sameDay, clientKey: "22222222-2222-4222-8222-222222222222" })).rejects.toThrow("past new request");
  });
  it("preserves existing schedule and resolves daily tasks in the workspace zone", async () => {
    const { deps, calls } = setup();
    calls.settings.get.mockResolvedValue({ settings: { ...DEFAULT_OPENING_PLANNING_SETTINGS, timeZone: "America/Los_Angeles" }, saved: true, invalidStoredSettings: false });
    deps.now = () => new Date("2026-10-19T03:00:00Z");
    await startFirstLearning(deps, scope, input);
    expect(calls.settings.initialize).not.toHaveBeenCalled();
    expect(calls.firstLearning.initialize).toHaveBeenCalledWith(scope, expect.objectContaining({ startDate: "2026-10-18", planTimeZone: "America/Los_Angeles" }), { replayOnly: false });
    expect(calls.plans.getToday).toHaveBeenCalledWith(scope, "2026-10-18");
    expect(calls.settings.set).not.toHaveBeenCalled();
  });
  it("refuses to replace invalid stored settings", async () => {
    const { deps, calls } = setup();
    calls.settings.get.mockResolvedValue({ settings: null, saved: true, invalidStoredSettings: true });
    await expect(startFirstLearning(deps, scope, input)).rejects.toThrow();
    expect(calls.firstLearning.initialize).not.toHaveBeenCalled();
  });
  it("does not initialize the schedule or read a plan when source admission fails", async () => {
    const { deps, calls } = setup();
    calls.firstLearning.initialize.mockRejectedValue(new Error("source unavailable"));
    await expect(startFirstLearning(deps, scope, input)).rejects.toThrow("source unavailable");
    expect(calls.plans.getToday).not.toHaveBeenCalled();
    expect(calls.settings.initialize).not.toHaveBeenCalled();
  });
  it("reuses the original intent after a partial failure without recreating tasks", async () => {
    const { deps, calls } = setup();
    calls.settings.initialize.mockRejectedValueOnce(new Error("connection lost"));
    await expect(startFirstLearning(deps, scope, input)).rejects.toThrow("connection lost");
    await startFirstLearning(deps, scope, input);
    expect(calls.firstLearning.initialize.mock.calls[0]![1].intent).toEqual(calls.firstLearning.initialize.mock.calls[1]![1].intent);
    expect(calls.plans.createTaskWithOutcome).not.toHaveBeenCalled();
  });
  it("recovers only the missing legacy task without claiming a new course plan", async () => {
    const { deps, calls, initialized } = setup();
    calls.firstLearning.initialize.mockResolvedValue({ ...initialized, courseId: null, firstTaskId: null, tasks: [], legacy: true });
    await expect(startFirstLearning(deps, scope, input)).resolves.toMatchObject({ taskId: id, courseId: null, plannedDays: 0 });
    expect(calls.plans.createTaskWithOutcome).toHaveBeenCalledWith(scope, expect.objectContaining({ clientKey: `first-learning-activity:${id}`, origin: "manual" }));
  });
});
