import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OPENING_PLANNING_SETTINGS, sprintBudgetResponseSchema,
  type OpeningAdaptivePrefsResponse, type OpeningPlanningSettings, type OpeningPlanningSettingsResponse,
  type PlannedBlock, type TaskItem, type TimeBlock, type WeekSession,
} from "@aistudy/contracts";
import { createSprintBudgetService, type SprintBudgetReader } from "./sprint-budget-service";

const courseId = "a1111111-1111-4111-8111-111111111111";
const otherCourseId = "b1111111-1111-4111-8111-111111111111";
const scope = { workspaceId: "22222222-2222-4222-8222-222222222222", ownerUserId: "33333333-3333-4333-8333-333333333333" };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-10-23T08:00:00.000Z";
const task = (n: number, changes: Partial<TaskItem> = {}): TaskItem => ({
  id: id(n), title: `已保存的复习任务 ${n}`, courseId, status: "pending", priority: 1,
  minutes: 30, dueAt: null, suggestionKind: "review_cards", ...changes,
});
function preferences(targetDate: string | null = "2026-10-24", weeklyMinutes = 423): OpeningAdaptivePrefsResponse {
  return { prefs: { autonomy: "coach", coachBudgetMinutes: 60, coachAutoAcceptEnabled: true,
    courseGoals: { [courseId]: { targetDate, weeklyMinutes } } }, saved: true, invalidStoredPrefs: false };
}
function settings(changes: Partial<OpeningPlanningSettings> = {}): OpeningPlanningSettingsResponse {
  return { settings: { ...DEFAULT_OPENING_PLANNING_SETTINGS, weekOneMonday: "2026-10-19",
    timeZone: "UTC", dailyWindow: { start: "09:00", end: "12:00" }, ...changes }, saved: true, invalidStoredSettings: false };
}
function fixture(options: {
  prefs?: OpeningAdaptivePrefsResponse; settings?: OpeningPlanningSettingsResponse;
  tasks?: TaskItem[]; timetable?: WeekSession[]; now?: string;
  days?: Record<string, { accepted: PlannedBlock[]; hard: TimeBlock[] }>;
} = {}) {
  const stored = structuredClone({
    prefs: options.prefs ?? preferences(), settings: options.settings ?? settings(),
    tasks: options.tasks ?? [task(1)], timetable: options.timetable ?? [], days: options.days ?? {},
  });
  const reader = {
    assertCourse: vi.fn<SprintBudgetReader["assertCourse"]>().mockResolvedValue(undefined),
    preferences: vi.fn<SprintBudgetReader["preferences"]>().mockResolvedValue(stored.prefs),
    settings: vi.fn<SprintBudgetReader["settings"]>().mockResolvedValue(stored.settings),
    tasks: vi.fn<SprintBudgetReader["tasks"]>().mockResolvedValue(stored.tasks),
    timetable: vi.fn<SprintBudgetReader["timetable"]>().mockResolvedValue(stored.timetable),
    constraints: vi.fn<SprintBudgetReader["constraints"]>().mockImplementation(async () => ({
      accepted: Object.values(stored.days).flatMap(day => day.accepted),
      locked: Object.values(stored.days).flatMap(day => day.hard).filter(block => block.kind === "locked"),
    })),
  } satisfies SprintBudgetReader;
  const clock = vi.fn(() => new Date(options.now ?? now));
  return { stored, reader, clock, service: createSprintBudgetService(reader, clock) };
}
function expectNoPlanningReads(reader: ReturnType<typeof fixture>["reader"]) {
  for (const read of [reader.tasks, reader.timetable, reader.constraints]) expect(read).not.toHaveBeenCalled();
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("sprint budget service (real deriveDayBlocks and forecastSprintBudget)", () => {
  it("awaits ownership before every other read, rather than merely starting the check first", async () => {
    const { reader, service } = fixture();
    let allow!: () => void;
    reader.assertCourse.mockReturnValue(new Promise<void>(resolve => { allow = resolve; }));
    const pending = service.read(scope, courseId);
    expect(reader.assertCourse).toHaveBeenCalledExactlyOnceWith(scope, courseId);
    for (const read of [reader.preferences, reader.settings, reader.tasks, reader.timetable, reader.constraints]) expect(read).not.toHaveBeenCalled();
    allow();
    expect((await pending).status).toBe("ready");
    expect(reader.preferences).toHaveBeenCalledExactlyOnceWith(scope);
    expect(reader.settings).toHaveBeenCalledExactlyOnceWith(scope);
    expect(reader.tasks).toHaveBeenCalledExactlyOnceWith(scope);
    expect(reader.timetable).toHaveBeenCalledExactlyOnceWith(scope);
    expect(reader.constraints).toHaveBeenCalledExactlyOnceWith(scope, { windowStart: "2026-10-23T00:00:00.000Z", windowEnd: "2026-10-24T00:00:00.000Z", now, taskIds: [id(1)] });
  });

  it("does not leak any workspace data when ownership is rejected", async () => {
    const { reader, service } = fixture();
    const denied = Object.assign(new Error("course not found"), { code: "NOT_FOUND" });
    reader.assertCourse.mockRejectedValue(denied);
    await expect(service.read(scope, courseId)).rejects.toBe(denied);
    expect(reader.preferences).not.toHaveBeenCalled();
    expect(reader.settings).not.toHaveBeenCalled();
    expectNoPlanningReads(reader);
  });

  it("rejects invalid UUIDs before invoking the reader", async () => {
    const { reader, service } = fixture();
    await expect(service.read(scope, "not-a-course-id")).rejects.toMatchObject({ name: "ZodError" });
    for (const read of Object.values(reader)) expect(read).not.toHaveBeenCalled();
  });

  it("canonicalizes uppercase UUIDs for authorization and the course-goal map", async () => {
    const { reader, service } = fixture();
    const result = await service.read(scope, courseId.toUpperCase());
    expect(reader.assertCourse).toHaveBeenCalledExactlyOnceWith(scope, courseId);
    expect(result).toMatchObject({ courseId, status: "ready", examDate: "2026-10-24", scheduledTaskIds: [id(1)] });
  });

  it.each([
    { label: "missing prefs", prefs: { prefs: { autonomy: "copilot" as const, coachBudgetMinutes: 60, courseGoals: {} }, saved: false, invalidStoredPrefs: false }, status: "needs_goal" },
    { label: "missing course goal", prefs: { ...preferences(), prefs: { ...preferences().prefs, courseGoals: {} } }, status: "needs_goal" },
    { label: "invalid stored prefs", prefs: { ...preferences(), invalidStoredPrefs: true }, status: "invalid_settings" },
    { label: "invalid stored settings", settings: { settings: null, saved: true, invalidStoredSettings: true }, status: "invalid_settings" },
    { label: "missing settings", settings: { settings: null, saved: false, invalidStoredSettings: false }, status: "needs_settings" },
    { label: "unsaved settings", settings: { ...settings(), saved: false }, status: "needs_settings" },
    { label: "saved null settings", settings: { settings: null, saved: true, invalidStoredSettings: false }, status: "needs_settings" },
    { label: "invalid timezone", settings: settings({ timeZone: "Mars/Olympus_Mons" }), status: "invalid_settings" },
  ])("returns $status for $label without planning, default persistence or data repair", async sample => {
    const { reader, service } = fixture(sample);
    const result = await service.read(scope, courseId);
    expect(result).toMatchObject({ status: sample.status, days: [], tasks: [], scheduledTaskIds: [], unscheduled: [], deferredTaskIds: [], horizonTruncated: false });
    expect(sprintBudgetResponseSchema.safeParse(result).success).toBe(true);
    expectNoPlanningReads(reader);
  });

  it.each([0, 6])("requires a usable daily budget instead of guessing when weeklyMinutes is %s", async weeklyMinutes => {
    const { reader, service } = fixture({ prefs: preferences("2026-10-24", weeklyMinutes) });
    expect(await service.read(scope, courseId)).toMatchObject({ status: "needs_goal", dailyMinutes: 0, days: [] });
    expectNoPlanningReads(reader);
  });

  it("does not infer an unknown exam date from task deadlines, other course goals, or the clock", async () => {
    const prefs = preferences(null);
    prefs.prefs.courseGoals[otherCourseId] = { targetDate: "2026-10-24", weeklyMinutes: 700 };
    const { reader, service } = fixture({ prefs, tasks: [task(1, { dueAt: "2026-10-24T10:00:00.000Z" })] });
    expect(await service.read(scope, courseId)).toMatchObject({ status: "needs_goal", examDate: null, timeZone: null, days: [] });
    expectNoPlanningReads(reader);
  });

  it.each(["preferences", "settings"] as const)("rejects malformed %s repository data instead of fabricating a usable configuration", async field => {
    const { reader, service } = fixture();
    if (field === "preferences") reader.preferences.mockResolvedValue({ prefs: {} } as OpeningAdaptivePrefsResponse);
    else reader.settings.mockResolvedValue({ ...settings(), settings: { ...settings().settings!, dailyWindow: { start: "11:00", end: "09:00" } } });
    await expect(service.read(scope, courseId)).rejects.toMatchObject({ name: "ZodError" });
    expectNoPlanningReads(reader);
  });

  it("rejects an impossible stored exam date rather than rolling it into the next month", async () => {
    const { reader, service } = fixture({ prefs: preferences("2026-02-30") });
    await expect(service.read(scope, courseId)).rejects.toMatchObject({ name: "ZodError" });
    expectNoPlanningReads(reader);
  });

  it("does not guess absolute class times when timetable period mappings are missing", async () => {
    const { reader, service } = fixture({ timetable: [{ courseName: "线性代数", courseId: otherCourseId,
      weekday: 5, weeks: [1], startPeriod: 1, endPeriod: 1 }] });
    expect(await service.read(scope, courseId)).toMatchObject({ status: "invalid_settings", days: [], tasks: [] });
    expect(reader.constraints).not.toHaveBeenCalled();
  });

  it("returns invalid_settings, not a guessed instant, for a nonexistent DST clock", async () => {
    const { reader, service } = fixture({ now: "2026-03-08T05:00:00.000Z", prefs: preferences("2026-03-09"),
      settings: settings({ timeZone: "America/New_York", dailyWindow: { start: "02:30", end: "04:00" } }) });
    expect(await service.read(scope, courseId)).toMatchObject({ status: "invalid_settings", days: [] });
    expect(reader.constraints).not.toHaveBeenCalled();
  });

  it.each([
    { time: "2026-10-23T15:59:00.000Z", zone: "Asia/Shanghai", exam: "2026-10-24", status: "ready", dates: ["2026-10-23"] },
    { time: "2026-10-23T16:00:00.000Z", zone: "Asia/Shanghai", exam: "2026-10-24", status: "deadline_reached", dates: [] },
    { time: "2026-10-23T16:00:00.000Z", zone: "Asia/Shanghai", exam: "2026-10-23", status: "deadline_reached", dates: [] },
    { time: "2026-03-08T04:30:00.000Z", zone: "America/New_York", exam: "2026-03-09", status: "ready", dates: ["2026-03-07", "2026-03-08"] },
    { time: "2026-03-08T05:00:00.000Z", zone: "America/New_York", exam: "2026-03-09", status: "ready", dates: ["2026-03-08"] },
  ])("uses the workspace day at $time in $zone (exam day excluded)", async sample => {
    const { reader, service } = fixture({ now: sample.time, prefs: preferences(sample.exam), settings: settings({ timeZone: sample.zone }), tasks: [] });
    const result = await service.read(scope, courseId);
    expect(result).toMatchObject({ generatedAt: sample.time, timeZone: sample.zone, status: sample.status });
    expect(result.days.map(day => day.date)).toEqual(sample.dates);
    expect(reader.constraints).toHaveBeenCalledTimes(sample.dates.length ? 1 : 0);
    if (!sample.dates.length) expectNoPlanningReads(reader);
  });

  it("derives task instants in the configured zone rather than the process/UTC day", async () => {
    const { service } = fixture({ now: "2026-10-23T16:10:00.000Z", prefs: preferences("2026-10-25"), settings: settings({ timeZone: "Asia/Shanghai" }) });
    const result = await service.read(scope, courseId);
    expect(result.days).toEqual([expect.objectContaining({ date: "2026-10-24", blocks: [expect.objectContaining({
      taskId: id(1), start: "2026-10-24T01:00:00.000Z", end: "2026-10-24T01:30:00.000Z",
    })] })]);
  });

  it.each([
    { exam: "2026-11-20", truncated: false },
    { exam: "2026-11-21", truncated: true },
    { exam: "2027-01-01", truncated: true },
  ])("caps reads at 28 local days for $exam and reports horizonTruncated=$truncated", async sample => {
    const { reader, service } = fixture({ prefs: preferences(sample.exam), tasks: [task(1, { notBefore: "2026-11-20T00:00:00.000Z" })] });
    const result = await service.read(scope, courseId);
    expect(result.horizonTruncated).toBe(sample.truncated);
    expect(result.days).toHaveLength(28);
    expect(result.days[0]?.date).toBe("2026-10-23");
    expect(result.days.at(-1)?.date).toBe("2026-11-19");
    expect(new Set(result.days.map(day => day.date)).size).toBe(28);
    expect(reader.constraints).toHaveBeenCalledExactlyOnceWith(scope, { windowStart: "2026-10-23T00:00:00.000Z", windowEnd: "2026-11-20T00:00:00.000Z", now, taskIds: [id(1)] });
    expect(result.deferredTaskIds).toEqual([id(1)]);
    expect(result.scheduledTaskIds).toEqual([]);
    expect(result.unscheduled).toEqual([]);
    expect(result.warnings.some(warning => warning.includes("截断"))).toBe(sample.truncated);
  });

  it("combines real class constraints, stored hard blocks, all-course accepts and the floored weekly budget", async () => {
    const { stored, reader, service, clock } = fixture({
      settings: settings({ periodTimes: { "1": { start: "09:00", end: "09:30" } } }),
      timetable: [{ courseName: "另一门课的课表", courseId: otherCourseId, weekday: 5, weeks: [1], startPeriod: 1, endPeriod: 1 }],
      tasks: [task(1, { priority: 2, title: "独立复测已保存的第 7 题" }), task(2), task(3, { courseId: otherCourseId }),
        task(4, { status: "done" }), task(5, { status: "skipped" }), task(6, { courseId: undefined }),
        task(7, { notBefore: "2026-10-24T00:00:00.000Z" }), task(10, { minutes: 15 })],
      days: { "2026-10-23": {
        accepted: [
          { taskId: id(3), start: "2026-10-23T09:30:00.000Z", end: "2026-10-23T10:00:00.000Z", reason: "其他课程已确认" },
          { taskId: id(10), start: "2026-10-23T10:00:00.000Z", end: "2026-10-23T10:15:00.000Z", reason: "本课已确认" },
        ],
        hard: [
          { start: "2026-10-23T10:15:00.000Z", end: "2026-10-23T10:30:00.000Z", kind: "locked" },
          // Stored free rows must not enlarge the configured availability.
          { start: "2026-10-23T08:00:00.000Z", end: "2026-10-23T09:00:00.000Z", kind: "free" },
        ],
      } },
    });
    const before = structuredClone(stored);
    deepFreeze(stored);
    const result = await service.read(scope, courseId);
    expect(result).toMatchObject({ status: "ready", dailyMinutes: 60, generatedAt: now, horizonTruncated: false });
    expect(result.tasks).toEqual([1, 2, 7, 10].map(n => ({ id: id(n), title: stored.tasks.find(item => item.id === id(n))!.title })));
    expect(result.days).toEqual([expect.objectContaining({ date: "2026-10-23", budgetMinutes: 60, committedMinutes: 15, plannedMinutes: 30,
      blocks: [expect.objectContaining({ taskId: id(1), start: "2026-10-23T10:30:00.000Z", end: "2026-10-23T11:00:00.000Z" })],
    })]);
    expect(result.scheduledTaskIds).toEqual([id(1)]);
    expect(result.unscheduled).toEqual([{ taskId: id(2), reason: "daily_budget_exceeded" }]);
    expect(result.deferredTaskIds).toEqual([id(7)]);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("不代表"), expect.stringContaining("其他课程")]));
    expect(sprintBudgetResponseSchema.parse(result)).toEqual(result);
    expect(stored).toEqual(before);
    expect(clock).toHaveBeenCalledOnce();
    // The complete supplied interface contains reads only, yet the real forecast succeeds.
    expect(Object.keys(reader).sort()).toEqual(["assertCourse", "constraints", "preferences", "settings", "tasks", "timetable"]);
    expect(Object.keys(service)).toEqual(["read"]);
  });

  it("keeps concrete titles for legacy retests whose course binding exists only in the retest projection", async () => {
    const legacy = task(1, { courseId: undefined, origin: "retest", title: "复测已确认的错题",
      retest: { candidateId: id(101), activityId: id(201), courseId, skillLabel: "极限",
        prompt: "独立重做", recommendedAt: "2026-10-23T09:00:00.000Z" } });
    const { service } = fixture({ tasks: [legacy] });
    const result = await service.read(scope, courseId);
    expect(result.scheduledTaskIds).toEqual([legacy.id]);
    expect(result.tasks).toEqual([{ id: legacy.id, title: legacy.title }]);
    for (const block of result.days.flatMap(day => day.blocks)) {
      expect(result.tasks.some(item => item.id === block.taskId)).toBe(true);
    }
  });

  it("rejects an oversized task snapshot instead of silently planning a truncated subset", async () => {
    const { reader, service } = fixture({ tasks: Array.from({ length: 2001 }, (_, n) => task(n)) });
    await expect(service.read(scope, courseId)).rejects.toThrow(RangeError);
    expect(reader.constraints).not.toHaveBeenCalled();
  });

  it.each(["preferences", "settings", "tasks", "timetable", "constraints"] as const)("propagates %s read failures instead of returning an empty successful forecast", async field => {
    const { reader, service } = fixture();
    const failure = new Error(`failed ${field}`);
    reader[field].mockRejectedValue(failure);
    await expect(service.read(scope, courseId)).rejects.toBe(failure);
    expect(reader[field]).toHaveBeenCalledOnce();
  });
});
