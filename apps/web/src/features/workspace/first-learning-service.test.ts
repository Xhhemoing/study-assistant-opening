import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_PLANNING_SETTINGS, type TeachingActivity } from "@aistudy/contracts";
import { startFirstLearning, type FirstLearningDependencies } from "./first-learning-service";
import { ApiError } from "../auth/service";

const id = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: id, ownerUserId: id };
const input = { clientKey: id, topic: "线性代数", goal: "解释矩阵的几何意义", targetDate: "2026-11-01",
  minutes: 30, startTime: "19:00", timeZone: "Asia/Shanghai", sourceIds: [id] };
function setup() {
  const activity: TeachingActivity = { id, workspaceId: id, ownerUserId: id, courseId: null, status: "active",
    generateStatus: "queued", intentKind: "goal", intentSummary: input.topic, sourceIds: [id],
    pathVersion: 1, contentVersion: 0, clientKey: id, createdAt: "2026-10-19T10:30:00Z", updatedAt: "2026-10-19T10:30:00Z" };
  const deps = { activities: { create: vi.fn<FirstLearningDependencies["activities"]["create"]>(async (_scope, _input, options) => {
    if (options?.replayOnly) throw new ApiError("VALIDATION", "past new request", 400);
    return activity;
  }) },
    plans: { createTaskWithOutcome: vi.fn<FirstLearningDependencies["plans"]["createTaskWithOutcome"]>(async () => ({ task: { id, title: input.topic, minutes: 30, dueAt: null, priority: 1, status: "pending" as const }, replayed: false })),
      getToday: vi.fn(async () => ({ date: "2026-10-19", acceptedVersion: 0, blocks: [], hardBlocks: [], dailyDraft: null, dailyDraftSkippedReason: null })) },
    settings: { get: vi.fn<FirstLearningDependencies["settings"]["get"]>(async () => ({ settings: null, saved: false, invalidStoredSettings: false })),
      initialize: vi.fn(async () => true), set: vi.fn() },
    now: () => new Date("2026-10-19T10:30:00Z") };
  return { deps: deps as FirstLearningDependencies, calls: deps };
}
describe("first learning", () => {
  it("creates a real scoped activity and pending task, then requests an unaccepted daily draft", async () => {
    const { deps, calls } = setup();
    await expect(startFirstLearning(deps, scope, input)).resolves.toMatchObject({ activityId: id, taskId: id, planDate: "2026-10-19" });
    expect(calls.activities.create).toHaveBeenCalledWith(scope, expect.objectContaining({
      clientKey: `first-learning:${id}:activity`, intentKind: "goal", sourceIds: [id],
      intentSummary: expect.stringContaining(input.goal),
      createIntent: expect.objectContaining({ source: "onboarding", targetDate: input.targetDate }),
    }));
    expect(calls.plans.createTaskWithOutcome).toHaveBeenCalledWith(scope, expect.objectContaining({
      clientKey: `first-learning-activity:${id}`, minutes: 30, candidateId: null, origin: "manual",
    }));
    expect(calls.settings.initialize).toHaveBeenCalledWith(scope, expect.objectContaining({ weekOneMonday: "2026-10-19", dailyWindow: { start: "19:00", end: "19:30" } }));
    expect(calls.plans.getToday).toHaveBeenCalledWith(scope, "2026-10-19");
  });
  it.each([{ ...input, topic: "  " }, { ...input, targetDate: "2026-02-30" },
    { ...input, startTime: "23:50" }, { ...input, timeZone: "fake/zone" }, { ...input, ownerUserId: id }])("rejects invalid or forged input before writes", async raw => {
    const { deps, calls } = setup();
    await expect(startFirstLearning(deps, scope, raw)).rejects.toThrow();
    expect(calls.activities.create).not.toHaveBeenCalled();
    expect(calls.settings.initialize).not.toHaveBeenCalled();
  });
  it("allows an existing same-day intent to finish recovery after midnight, without permitting a new past intent", async () => {
    const { deps, calls } = setup();
    calls.settings.initialize.mockRejectedValueOnce(new Error("connection lost"));
    const sameDay = { ...input, targetDate: "2026-10-19" };
    await expect(startFirstLearning(deps, scope, sameDay)).rejects.toThrow("connection lost");
    const activity = await calls.activities.create.mock.results[0]!.value;
    calls.activities.create.mockResolvedValueOnce(activity);
    deps.now = () => new Date("2026-10-20T00:30:00Z");
    await startFirstLearning(deps, scope, sameDay);
    expect(calls.activities.create.mock.calls[1]![2]).toEqual({ replayOnly: true });
    expect(calls.plans.createTaskWithOutcome.mock.calls[0]![1]).toEqual(calls.plans.createTaskWithOutcome.mock.calls[1]![1]);
    await expect(startFirstLearning(deps, scope, { ...sameDay, clientKey: "22222222-2222-4222-8222-222222222222" })).rejects.toThrow("past new request");
  });
  it("preserves existing schedule and resolves the plan date in its workspace zone", async () => {
    const { deps, calls } = setup();
    calls.settings.get.mockResolvedValue({ settings: { ...DEFAULT_OPENING_PLANNING_SETTINGS, timeZone: "America/Los_Angeles" }, saved: true, invalidStoredSettings: false });
    deps.now = () => new Date("2026-10-19T03:00:00Z");
    await startFirstLearning(deps, scope, input);
    expect(calls.settings.initialize).not.toHaveBeenCalled();
    expect(calls.plans.getToday).toHaveBeenCalledWith(scope, "2026-10-18");
    expect(calls.settings.set).not.toHaveBeenCalled();
  });
  it("refuses to replace invalid stored settings", async () => {
    const { deps, calls } = setup();
    calls.settings.get.mockResolvedValue({ settings: null, saved: true, invalidStoredSettings: true });
    await expect(startFirstLearning(deps, scope, input)).rejects.toThrow();
    expect(calls.activities.create).not.toHaveBeenCalled();
  });
  it("lets the existing activity service reject inaccessible material before further writes", async () => {
    const { deps, calls } = setup();
    calls.activities.create.mockRejectedValue(new Error("source unavailable"));
    await expect(startFirstLearning(deps, scope, input)).rejects.toThrow("source unavailable");
    expect(calls.plans.createTaskWithOutcome).not.toHaveBeenCalled();
    expect(calls.settings.initialize).not.toHaveBeenCalled();
  });
  it("reuses both intent keys after a partial failure and does not claim success", async () => {
    const { deps, calls } = setup();
    calls.settings.initialize.mockRejectedValueOnce(new Error("connection lost"));
    await expect(startFirstLearning(deps, scope, input)).rejects.toThrow("connection lost");
    await startFirstLearning(deps, scope, input);
    expect(calls.activities.create.mock.calls[0]![1]).toEqual(calls.activities.create.mock.calls[1]![1]);
    expect(calls.plans.createTaskWithOutcome.mock.calls[0]![1]).toEqual(calls.plans.createTaskWithOutcome.mock.calls[1]![1]);
  });
});
