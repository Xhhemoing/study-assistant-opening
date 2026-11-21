import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { Sql } from "postgres";
const taskReads = vi.hoisted(() => ({
  listTasks: vi.fn(),
  getToday: vi.fn(),
  proposePlan: vi.fn(),
  upsertHardBlocks: vi.fn(),
  listHardBlocks: vi.fn(),
  listTimetable: vi.fn(),
  findDraftByProposeClientKey: vi.fn(),
  ensureAutoDraft: vi.fn(),
}));
const settingsReads = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue({ settings: null, invalidStoredSettings: false }),
}));
vi.mock("@aistudy/database", async original => ({
  ...await original<typeof import("@aistudy/database")>(),
  createOpeningPlansRepository: () => taskReads,
  createOpeningPlanningSettingsRepository: () => settingsReads,
}));
import { buildDailyDraftInput, planDay } from "@aistudy/domain";
import { OpeningPlanError, type AutoDraftBuild } from "@aistudy/database";
import type { OpeningPlanningSettings, TaskItem, TimeBlock } from "@aistudy/contracts";
import {
  buildServerPlanDayOptions,
  createOpeningPlanService,
  DEFAULT_PLANNING_TIME_ZONE,
  mapRepoError,
  resolvePlanningNowForLocalDay,
} from "./plan-service";

const SH = "Asia/Shanghai";
it("reads the existing daily draft without generating or changing plan state", async () => {
  const scope = { workspaceId: id(1), ownerUserId: id(1) };
  const date = "2026-11-19";
  const draft = { id: id(2), date, status: "draft" };
  taskReads.getToday.mockResolvedValueOnce(null);
  taskReads.listHardBlocks.mockResolvedValueOnce([]);
  taskReads.findDraftByProposeClientKey.mockResolvedValueOnce(draft);
  const service = createOpeningPlanService({} as Sql);
  expect(await service.readToday(scope, date)).toMatchObject({ date, acceptedVersion: 0, dailyDraft: draft });
  expect(taskReads.findDraftByProposeClientKey).toHaveBeenCalledWith(scope, date, "auto-draft:2026-11-19");
  expect(taskReads.ensureAutoDraft).not.toHaveBeenCalled();
});

it("projects persisted minutes without replacing the legacy task field and keeps UI listTasks unfiltered", async () => {
  taskReads.listTasks.mockReset();
  taskReads.listTasks.mockResolvedValue([task(1)]);
  const scope = { workspaceId: id(1), ownerUserId: id(1) };
  expect(await createOpeningPlanService({} as Sql).listTasks(scope))
    .toEqual([{ ...task(1), estimateMinutes: 30 }]);
  expect(taskReads.listTasks).toHaveBeenCalledWith(scope);
});

it("filters inactive retests in proposePlan and proposeDeltaPlan (when a retest task is requested)", async () => {
  const scope = { workspaceId: id(1), ownerUserId: id(1) };
  const freeSlot: TimeBlock[] = [{ start: "2026-10-09T09:00:00.000Z", end: "2026-10-09T11:00:00.000Z", kind: "free" }];
  const fakeDraft = {
    id: id(99),
    date: "2026-10-09",
    version: 0,
    baseVersion: 0,
    status: "draft" as const,
    blocks: [],
    unscheduledTaskIds: [],
    unscheduledReasons: [],
    suggestedTasks: [],
  };
  taskReads.listTasks.mockReset();
  taskReads.getToday.mockReset();
  taskReads.proposePlan.mockReset();
  taskReads.upsertHardBlocks.mockReset();
  taskReads.listTasks.mockResolvedValue([task(1)]);
  taskReads.getToday.mockResolvedValue(null);
  taskReads.upsertHardBlocks.mockResolvedValue([]);
  taskReads.proposePlan.mockResolvedValue(fakeDraft);

  const service = createOpeningPlanService({} as Sql, { now: () => new Date("2026-10-09T08:00:00.000Z") });
  await service.proposePlan(scope, { date: "2026-10-09", free: freeSlot });
  expect(taskReads.listTasks).toHaveBeenCalledWith(scope, { excludeInactiveRetests: true });

  // Delta plan with a retest task: ownership check uses unfiltered listTasks, planning uses excludeInactiveRetests.
  const inactiveRetest = retest(2, "2026-10-09T09:00:00.000Z");
  taskReads.listTasks.mockReset();
  taskReads.listTasks
    .mockResolvedValueOnce([task(1), inactiveRetest])
    .mockResolvedValueOnce([task(1)]);
  taskReads.proposePlan.mockClear();
  await service.proposeDeltaPlan(scope, {
    date: "2026-10-09",
    taskIds: [inactiveRetest.id],
    free: freeSlot,
    clientKey: "delta-test-key-1",
  });
  expect(taskReads.listTasks).toHaveBeenNthCalledWith(1, scope);
  expect(taskReads.listTasks).toHaveBeenNthCalledWith(2, scope, { excludeInactiveRetests: true });
  expect(taskReads.proposePlan).toHaveBeenCalledWith(
    scope,
    expect.objectContaining({ blocks: [] }),
  );
});

it("preserves the conflict reason through the service's HTTP error mapping", () => {
  expect(mapRepoError(new OpeningPlanError("CONFLICT", "selection changed", "selection_mismatch")))
    .toMatchObject({ code: "CONFLICT", status: 409, reason: "selection_mismatch" });
});
const day = "2026-10-09";
const at = (clock: string) => `2026-10-09T${clock}:00.000Z`;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function task(n: number, overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: id(n),
    title: `任务${n}`,
    minutes: 30,
    dueAt: null,
    priority: 1,
    status: "pending",
    ...overrides,
  };
}

function retest(n: number, recommendedAt: string): TaskItem {
  return task(n, {
    retest: {
      candidateId: id(90 + n),
      activityId: id(80 + n),
      courseId: id(70),
      skillLabel: "fractions",
      prompt: `隔天重做原题：${n}`,
      recommendedAt,
    },
  });
}

function slot(startClock: string, endClock: string): TimeBlock {
  return { start: at(startClock), end: at(endClock), kind: "free" };
}

describe("resolvePlanningNowForLocalDay", () => {
  it("returns ISO when now is inside the workspace local day", () => {
    // 2026-10-09 10:00 Asia/Shanghai = 02:00Z
    const now = new Date("2026-10-09T02:00:00.000Z");
    expect(resolvePlanningNowForLocalDay(day, SH, now)).toBe("2026-10-09T02:00:00.000Z");
  });

  it("omits planningNow for a past local day (historical propose / tests)", () => {
    const now = new Date("2026-10-10T02:00:00.000Z");
    expect(resolvePlanningNowForLocalDay(day, SH, now)).toBeUndefined();
  });

  it("omits planningNow for a future local day", () => {
    const now = new Date("2026-10-08T02:00:00.000Z");
    expect(resolvePlanningNowForLocalDay(day, SH, now)).toBeUndefined();
  });
});

describe("buildServerPlanDayOptions", () => {
  it("uses TZ01 localDate+timeZone and omits UTC dayEnd", () => {
    const opts = buildServerPlanDayOptions({
      date: day,
      timeZone: SH,
      now: new Date("2026-10-08T02:00:00.000Z"),
    });
    expect(opts).toEqual({ localDate: day, timeZone: SH });
    expect(opts).not.toHaveProperty("dayEnd");
    expect(opts).not.toHaveProperty("planningNow");
  });

  it("includes planningNow when now is on the planned local day", () => {
    const now = new Date("2026-10-09T02:00:00.000Z");
    const opts = buildServerPlanDayOptions({ date: day, timeZone: SH, now });
    expect(opts.planningNow).toBe(now.toISOString());
    expect(opts.localDate).toBe(day);
    expect(opts.timeZone).toBe(SH);
    expect(opts).not.toHaveProperty("dayEnd");
  });

  it("passes preferredOrder for daily-draft / delta paths", () => {
    const opts = buildServerPlanDayOptions({
      date: day,
      timeZone: DEFAULT_PLANNING_TIME_ZONE,
      now: new Date("2026-10-08T02:00:00.000Z"),
      preferredOrder: [id(1), id(2)],
    });
    expect(opts.preferredOrder).toEqual([id(1), id(2)]);
  });

  it("forwards explicit carryOverTaskIds and falls back to buildDailyDraftInput metadata", () => {
    const carry = task(1);
    const ordinary = task(2);
    const draft = buildDailyDraftInput({
      tasks: [carry, ordinary],
      yesterdayAccepted: [{ taskId: carry.id, start: "2026-10-08T09:00:00.000Z", end: "2026-10-08T09:30:00.000Z", reason: "昨天" }],
      dueRetests: [],
      freeBlocks: [slot("09:00", "12:00")],
      now: new Date(at("08:00")),
      timeZone: "UTC",
      date: day,
    });
    const fromSymbol = buildServerPlanDayOptions({
      date: day,
      timeZone: "UTC",
      now: new Date(at("08:00")),
      preferredOrder: draft.orderedTaskIds,
    });
    expect([...(fromSymbol.carryOverTaskIds ?? [])]).toEqual([carry.id]);

    const explicit = buildServerPlanDayOptions({
      date: day,
      timeZone: "UTC",
      now: new Date(at("08:00")),
      preferredOrder: [carry.id, ordinary.id],
      carryOverTaskIds: new Set([ordinary.id]),
    });
    expect([...(explicit.carryOverTaskIds ?? [])]).toEqual([ordinary.id]);
  });
});

describe("plan-service → planDay earliest wire", () => {
  it("clamps ordinary tasks to planningNow when options come from the server builder", () => {
    const now = new Date(at("10:00"));
    const opts = buildServerPlanDayOptions({ date: day, timeZone: SH, now });
    expect(opts.planningNow).toBe(at("10:00"));
    const result = planDay([task(1)], [slot("09:00", "12:00")], opts);
    expect(result.blocks).toEqual([
      { taskId: id(1), start: at("10:00"), end: at("10:30"), reason: expect.any(String) },
    ]);
  });

  it("does not schedule an afternoon retest before recommendedAt under server options", () => {
    const now = new Date(at("08:00"));
    const opts = buildServerPlanDayOptions({ date: day, timeZone: SH, now });
    const result = planDay([retest(1, at("14:00"))], [slot("09:00", "17:00")], opts);
    expect(result.unscheduledTaskIds).toEqual([]);
    expect(result.blocks[0]).toMatchObject({
      taskId: id(1),
      start: at("14:00"),
      end: at("14:30"),
    });
  });

  it("keeps morning free usable when preferredOrder would otherwise grab the afternoon retest first", () => {
    const now = new Date(at("08:00"));
    const opts = buildServerPlanDayOptions({
      date: day,
      timeZone: SH,
      now,
      preferredOrder: [id(1), id(2)],
    });
    const result = planDay(
      [retest(1, at("14:00")), task(2)],
      [slot("09:00", "17:00")],
      opts,
    );
    expect(result.blocks.map(({ taskId, start, end }) => ({ taskId, start, end }))).toEqual([
      { taskId: id(2), start: at("09:00"), end: at("09:30") },
      { taskId: id(1), start: at("14:00"), end: at("14:30") },
    ]);
  });

  it("does not clamp historical dates so past-day proposes still use slot.start", () => {
    const wallClock = new Date("2026-10-10T12:00:00.000Z");
    const opts = buildServerPlanDayOptions({ date: day, timeZone: SH, now: wallClock });
    expect(opts.planningNow).toBeUndefined();
    const result = planDay([task(1)], [slot("09:00", "12:00")], opts);
    expect(result.blocks[0]?.start).toBe(at("09:00"));
  });

  it("preserves carryOverTaskIds from buildDailyDraftInput into ensureDailyDraft non-adaptive planDay", async () => {
    const scope = { workspaceId: id(1), ownerUserId: id(1) };
    const date = "2026-09-14";
    const utcAt = (clock: string) => `${date}T${clock}:00.000Z`;
    const pinned = task(1, { minutes: 10, notBefore: utcAt("11:00"), dueAt: utcAt("11:10") });
    const carry = task(2, { minutes: 30, priority: 5 });
    const ordinary = task(3, { minutes: 30, priority: 1 });
    const planningSettings: OpeningPlanningSettings = {
      weekOneMonday: "2026-09-07",
      periodTimes: { "1": { start: "08:00", end: "08:45" } },
      dailyWindow: { start: "09:00", end: "12:20" },
      lunch: { start: "12:20", end: "13:00" },
      dinner: { start: "17:30", end: "18:30" },
      sleep: { start: "23:00", end: "07:00" },
      timeZone: "UTC",
    };

    let built: AutoDraftBuild | undefined;
    taskReads.listTimetable.mockReset().mockResolvedValue([]);
    taskReads.listTasks.mockReset().mockResolvedValue([carry, pinned, ordinary]);
    taskReads.getToday.mockReset().mockResolvedValue({
      acceptedVersion: 1,
      blocks: [{ taskId: carry.id, start: "2026-09-13T09:00:00.000Z", end: "2026-09-13T09:30:00.000Z", reason: "昨天" }],
    });
    taskReads.ensureAutoDraft.mockReset().mockImplementation(async (_scope, _date, _key, build) => {
      built = await build();
      return { draft: null, skippedBecauseAccepted: false, dailyDraftSkippedReason: null };
    });
    settingsReads.get.mockResolvedValue({ saved: true, settings: planningSettings, invalidStoredSettings: false });
    try {
      const service = createOpeningPlanService({} as Sql, { now: () => new Date(utcAt("08:00")) });
      await service.ensureDailyDraft(scope, date);
    } finally {
      settingsReads.get.mockResolvedValue({ settings: null, invalidStoredSettings: false });
    }

    expect(built?.kind).toBe("propose");
    if (built?.kind !== "propose") throw new Error("expected propose build");
    expect(built.input.unscheduledTaskIds).toEqual([]);
    expect(built.input.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
      [ordinary.id, utcAt("09:00"), utcAt("09:30")],
      [pinned.id, utcAt("11:00"), utcAt("11:10")],
      [carry.id, utcAt("11:10"), utcAt("11:40")],
    ]);
    expect(built.input.blocks.find((block) => block.taskId === carry.id)?.reason).toBe("顺延自昨天");
  });

  it("ranks an end-of-local-day deadline ahead of undated carry-over through buildDailyDraftInput and planDay", () => {
    const date = "2026-09-14", timeZone = "America/Los_Angeles";
    const now = new Date("2026-09-15T06:00:00.000Z");
    const carry = task(1, { priority: 5 });
    const endOfDayDeadline = task(2, { priority: 1, dueAt: "2026-09-15T07:00:00.000Z" });
    const freeBlocks: TimeBlock[] = [{
      start: "2026-09-15T06:30:00.000Z", end: "2026-09-15T07:00:00.000Z", kind: "free",
    }];
    const { orderedTaskIds, carryOverTaskIds } = buildDailyDraftInput({
      tasks: [carry, endOfDayDeadline],
      yesterdayAccepted: [{
        taskId: carry.id, start: "2026-09-14T06:00:00.000Z", end: "2026-09-14T06:30:00.000Z", reason: "昨天",
      }],
      dueRetests: [],
      freeBlocks,
      now,
      timeZone,
      date,
    });
    expect(orderedTaskIds).toEqual([endOfDayDeadline.id, carry.id]);
    const planned = planDay(
      [carry, endOfDayDeadline],
      freeBlocks,
      buildServerPlanDayOptions({ date, timeZone, now, preferredOrder: orderedTaskIds, carryOverTaskIds }),
    );
    expect(planned.blocks.map((block) => block.taskId)).toEqual([endOfDayDeadline.id]);
    expect(planned.unscheduledTaskIds).toEqual([carry.id]);
  });
});

describe("mapRepoError (PR-E)", () => {
  it("maps a residual unique violation (23505) to 409 CONFLICT instead of 500", () => {
    const pgError = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    expect(mapRepoError(pgError)).toMatchObject({ code: "CONFLICT", status: 409 });
  });

  it("leaves other database errors untouched", () => {
    const pgError = Object.assign(new Error("deadlock"), { code: "40P01" });
    expect(mapRepoError(pgError)).toBe(pgError);
  });
});
