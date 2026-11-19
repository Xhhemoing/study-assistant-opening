import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX,
  DAY_ADJUSTMENT_STRATEGY_VERSION,
  DAY_EXCEPTION_PROPOSE_KEY_PREFIX,
  DAY_EXCEPTION_SNAPSHOT_KIND,
  DAY_EXCEPTION_STRATEGY_VERSION,
  dayExceptionReceiptSchema,
  type DayAdjustmentConfirmInput,
} from "@aistudy/contracts";
import {
  computeDayAdjustmentConfirmPayloadHash,
  createOpeningDayAdjustmentRepository,
} from "./opening-day-adjustment";
import {
  calculateDayExceptionUsageBounds,
  evaluateDayPlanCapacity,
} from "./opening-learning-capacity-usage";
import { assertOpeningLearningManagementDraft } from "./opening-learning-management-draft";
import { OpeningPlanError } from "./opening-plan-error";

const WS_A = "11111111-1111-4111-8111-111111111111";
const OWNER_A = "22222222-2222-4222-8222-222222222222";
const WS_B = "33333333-3333-4333-8333-333333333333";
const OWNER_B = "44444444-4444-4444-8444-444444444444";
const WRITING_ID = "55555555-5555-4555-8555-555555555555";
const MATH_ID = "66666666-6666-4666-8666-666666666666";
const RETEST_ID = "77777777-7777-4777-8777-777777777777";
const DUE_TODAY_ID = "88888888-8888-4888-8888-888888888888";
const EXC_ID = "99999999-9999-4999-8999-999999999999";

function createMockSql(
  handler: (query: string, values: unknown[]) => unknown[] | Promise<unknown[]>,
): Sql {
  const fn = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    return Promise.resolve(handler(query, values));
  };
  const tx = Object.assign(fn, {
    json: (value: unknown) => value,
  });
  return Object.assign(fn, {
    json: (value: unknown) => value,
    begin: async (...args: unknown[]) => {
      const callback = args[args.length - 1] as (t: unknown) => Promise<unknown>;
      return callback(tx);
    },
  }) as unknown as Sql;
}

describe("computeDayAdjustmentConfirmPayloadHash", () => {
  const baseInput: DayAdjustmentConfirmInput = {
    clientKey: "day-adjust:thu-to-fri",
    sourceDate: "2026-11-19",
    expectedTimeZone: "Asia/Shanghai",
    expectedExceptionRevision: 1,
    expectedBudgetRevision: 1,
    expectedSourceAcceptedVersion: 1,
    expectedTargetAcceptedVersion: 0,
    expectedTaskRevisions: [
      { taskId: MATH_ID, version: 1 },
      { taskId: WRITING_ID, version: 1 },
    ],
    expectedRetestRevisions: [
      {
        retestId: RETEST_ID,
        taskId: MATH_ID,
        version: 1,
        scheduledStartAt: "2026-11-19T11:15:00.000Z",
      },
    ],
    sourceActions: {
      keptBlocks: [
        {
          taskId: WRITING_ID,
          start: "2026-11-19T11:00:00.000Z",
          end: "2026-11-19T11:15:00.000Z",
          reason: "planned",
        },
      ],
      removedBlocks: [
        {
          taskId: MATH_ID,
          start: "2026-11-19T11:15:00.000Z",
          end: "2026-11-19T11:40:00.000Z",
          reason: "planned",
        },
      ],
      addedBlocks: [],
    },
    targetActions: {
      targetDate: "2026-11-20",
      addedBlocks: [
        {
          taskId: MATH_ID,
          start: "2026-11-20T11:15:00.000Z",
          end: "2026-11-20T11:40:00.000Z",
          reason: "planned",
        },
      ],
    },
  };

  it("is order-insensitive for task revisions and timestamps with equivalent ISO instants", () => {
    const reordered: DayAdjustmentConfirmInput = {
      ...baseInput,
      expectedTaskRevisions: [...baseInput.expectedTaskRevisions].reverse(),
      sourceActions: {
        ...baseInput.sourceActions,
        keptBlocks: [
          {
            taskId: WRITING_ID,
            start: "2026-11-19T19:00:00+08:00",
            end: "2026-11-19T19:15:00+08:00",
            reason: "planned",
          },
        ],
      },
    };
    expect(computeDayAdjustmentConfirmPayloadHash(reordered)).toBe(
      computeDayAdjustmentConfirmPayloadHash(baseInput),
    );
  });

  it("changes hash when any target slot or version differs", () => {
    const modified: DayAdjustmentConfirmInput = {
      ...baseInput,
      targetActions: {
        targetDate: "2026-11-20",
        addedBlocks: [
          {
            taskId: MATH_ID,
            start: "2026-11-20T11:30:00.000Z",
            end: "2026-11-20T11:55:00.000Z",
            reason: "planned",
          },
        ],
      },
    };
    expect(computeDayAdjustmentConfirmPayloadHash(modified)).not.toBe(
      computeDayAdjustmentConfirmPayloadHash(baseInput),
    );
  });
});

describe("calculateDayExceptionUsageBounds & evaluateDayPlanCapacity", () => {
  const day = { localDate: "2026-11-19", timeZone: "Asia/Shanghai" };
  const effectiveAt = "2026-11-19T11:00:00.000Z";

  it("computes post-replacement capacity with Thu Writing 15m kept and Math 25m moved out", () => {
    const writingBlock = {
      taskId: WRITING_ID,
      start: "2026-11-19T11:00:00.000Z",
      end: "2026-11-19T11:15:00.000Z",
    };
    const mathBlock = {
      taskId: MATH_ID,
      start: "2026-11-19T11:15:00.000Z",
      end: "2026-11-19T11:40:00.000Z",
    };
    const tasks = [
      { id: WRITING_ID, status: "pending", minutes: 15 },
      { id: MATH_ID, status: "pending", minutes: 25 },
    ];

    const before = evaluateDayPlanCapacity({
      day,
      budget: { dailyMinutes: 90, bufferMinutes: 15 },
      dayException: { effectiveAt, remainingMinutes: 15 },
      activities: [],
      tasks,
      afterBlocks: [writingBlock, mathBlock],
    });
    expect(before.requiredMinutes).toBe(40);
    expect(before.availableUpperMinutes).toBe(15);
    expect(before.shortfallMinutes).toBe(25);
    expect(before.usageUncertain).toBe(false);

    const after = evaluateDayPlanCapacity({
      day,
      budget: { dailyMinutes: 90, bufferMinutes: 15 },
      dayException: { effectiveAt, remainingMinutes: 15 },
      activities: [],
      tasks,
      afterBlocks: [writingBlock],
      excludeTaskIds: new Set([MATH_ID]),
    });
    expect(after.requiredMinutes).toBe(15);
    expect(after.shortfallMinutes).toBe(0);
    expect(after.usageUncertain).toBe(false);
  });

  it("never skips blocks actually written into afterBlocks even when passed in excludeTaskIds", () => {
    const mathBlock = {
      taskId: MATH_ID,
      start: "2026-11-19T11:15:00.000Z",
      end: "2026-11-19T11:40:00.000Z",
    };
    const evaluated = evaluateDayPlanCapacity({
      day,
      budget: { dailyMinutes: 90, bufferMinutes: 15 },
      dayException: { effectiveAt, remainingMinutes: 15 },
      activities: [],
      tasks: [{ id: MATH_ID, status: "pending", minutes: 25 }],
      afterBlocks: [mathBlock],
      excludeTaskIds: new Set([MATH_ID]),
    });
    expect(evaluated.requiredMinutes).toBe(25);
    expect(evaluated.shortfallMinutes).toBe(10);
  });

  it("charges unscheduled ordinary pending tasks due on the target day into shared daily budget Sday", () => {
    const friday = { localDate: "2026-11-20", timeZone: "Asia/Shanghai" };
    const mathFridayBlock = {
      taskId: MATH_ID,
      start: "2026-11-20T11:15:00.000Z",
      end: "2026-11-20T11:40:00.000Z",
    };
    const evaluated = evaluateDayPlanCapacity({
      day: friday,
      budget: { dailyMinutes: 45, bufferMinutes: 15 }, // net 30m
      dayException: null,
      activities: [],
      tasks: [
        { id: MATH_ID, status: "pending", minutes: 25, due_at: null },
        { id: DUE_TODAY_ID, status: "pending", minutes: 25, due_at: "2026-11-20T13:00:00.000Z" },
      ],
      afterBlocks: [mathFridayBlock],
    });
    // 25m unscheduled due-today task + 25m moved block = 50m > 30m net => shortfall 20m.
    expect(evaluated.dayUsedMinutes).toBe(25);
    expect(evaluated.shortfallMinutes).toBe(20);
  });

  it("returns usageUncertain when an activity straddles effectiveAt with only total elapsed minutes", () => {
    const straddlingActivity = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "completed",
      created_at: "2026-11-19T10:45:00.000Z",
      updated_at: "2026-11-19T11:15:00.000Z",
      create_intent: { protocol: "card-review-session-v1" },
      checkpoint_json: {
        cardReviewSession: {
          stoppedAt: "2026-11-19T11:15:00.000Z",
          elapsedSeconds: 1200,
        },
      },
      goal_json: {
        learningBudget: { localDate: "2026-11-19", timeZone: "Asia/Shanghai", minutes: 20 },
      },
    };
    const bounds = calculateDayExceptionUsageBounds(day, effectiveAt, [straddlingActivity], [], []);
    expect(bounds).toEqual({ dayUsedMinutes: 20, afterLowerMinutes: 5, afterUpperMinutes: 15 });

    const evaluated = evaluateDayPlanCapacity({
      day,
      budget: { dailyMinutes: 90, bufferMinutes: 15 },
      dayException: { effectiveAt, remainingMinutes: 15 },
      activities: [straddlingActivity],
      tasks: [{ id: WRITING_ID, status: "pending", minutes: 10 }],
      afterBlocks: [
        {
          taskId: WRITING_ID,
          start: "2026-11-19T11:20:00.000Z",
          end: "2026-11-19T11:30:00.000Z",
        },
      ],
    });
    expect(evaluated.usageUncertain).toBe(true);
  });
});

describe("createOpeningDayAdjustmentRepository P1 behavioral invariants", () => {
  it("isolates same clientKey across workspaces, emits strict receipt without kind, and reads clock after locks", async () => {
    const storedDrafts: Array<Record<string, unknown>> = [];
    let now = new Date("2026-11-19T10:55:00.000Z"); // 18:55 Asia/Shanghai
    let advancePastMidnightOnLock = false;

    const sql = createMockSql((query, values) => {
      if (query.includes("pg_advisory_xact_lock")) {
        if (advancePastMidnightOnLock) {
          now = new Date("2026-11-19T16:30:00.000Z"); // 2026-11-20 00:30 Asia/Shanghai
        }
        return [];
      }
      if (query.includes("opening_workspace_history_revisions")) return [];
      if (query.includes("FROM workspaces")) {
        return [{ id: values[0] }];
      }
      if (query.includes("AND propose_client_key =")) {
        const [wsId, ownerId, proposeKey] = values;
        return storedDrafts.filter(
          (row) => row.workspace_id === wsId && row.owner_user_id === ownerId && row.propose_client_key === proposeKey,
        );
      }
      if (query.includes("AND strategy_version =")) {
        const [wsId, ownerId, day] = values;
        return storedDrafts
          .filter((row) => row.workspace_id === wsId && row.owner_user_id === ownerId && row.day === day)
          .sort((a, b) => Number(b.version) - Number(a.version));
      }
      if (query.includes("FROM workspace_preferences")) {
        return [{
          planning_settings: {
            weekOneMonday: "2026-09-07",
            periodTimes: {},
            dailyWindow: { start: "07:30", end: "22:30" },
            lunch: { start: "12:00", end: "12:45" },
            dinner: { start: "18:00", end: "18:45" },
            sleep: { start: "23:00", end: "07:00" },
            timeZone: "Asia/Shanghai",
          },
        }];
      }
      if (query.includes("INSERT INTO opening_plan_drafts")) {
        const [id, workspace_id, owner_user_id, day, version, base_version, input_snapshot, propose_client_key, reasons, strategy_version] = values;
        storedDrafts.push({
          id,
          workspace_id,
          owner_user_id,
          day,
          version,
          base_version,
          input_snapshot,
          propose_client_key,
          reasons,
          strategy_version,
        });
        return [];
      }
      throw new Error(`Unexpected SQL: ${query}`);
    });

    const repo = createOpeningDayAdjustmentRepository(sql, { clock: () => now });
    const sharedClientKey = "12121212-1212-4121-8121-121212121212";

    const receiptA = await repo.declareToday(
      { workspaceId: WS_A, ownerUserId: OWNER_A },
      {
        clientKey: sharedClientKey,
        localDate: "2026-11-19",
        expectedTimeZone: "Asia/Shanghai",
        expectedExceptionRevision: 0,
        remainingMinutes: 15,
      },
    );
    expect(dayExceptionReceiptSchema.parse(receiptA)).toEqual(receiptA);
    expect("kind" in receiptA).toBe(false);
    expect(receiptA.id).not.toBe(sharedClientKey);
    expect(receiptA.replayed).toBe(false);

    // Different tenant reusing the EXACT same clientKey succeeds cleanly without collision.
    const receiptB = await repo.declareToday(
      { workspaceId: WS_B, ownerUserId: OWNER_B },
      {
        clientKey: sharedClientKey,
        localDate: "2026-11-19",
        expectedTimeZone: "Asia/Shanghai",
        expectedExceptionRevision: 0,
        remainingMinutes: 30,
      },
    );
    expect(receiptB.id).not.toBe(receiptA.id);
    expect(receiptB.remainingMinutes).toBe(30);
    expect(receiptB.replayed).toBe(false);

    // Lock wait crossing midnight rejects a NEW declaration for yesterday, while committed key still replays.
    advancePastMidnightOnLock = true;
    await expect(
      repo.declareToday(
        { workspaceId: WS_A, ownerUserId: OWNER_A },
        {
          clientKey: "34343434-3434-4343-8343-343434343434",
          localDate: "2026-11-19",
          expectedTimeZone: "Asia/Shanghai",
          expectedExceptionRevision: 1,
          remainingMinutes: 20,
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "stale_version" });

    const replayedA = await repo.declareToday(
      { workspaceId: WS_A, ownerUserId: OWNER_A },
      {
        clientKey: sharedClientKey,
        localDate: "2026-11-19",
        expectedTimeZone: "Asia/Shanghai",
        expectedExceptionRevision: 0,
        remainingMinutes: 15,
      },
    );
    expect(replayedA.replayed).toBe(true);
    expect(replayedA.id).toBe(receiptA.id);
  });

  it("rejects Tx2 confirm on dayException timeZone drift, same task on both days, and post-lock slot expiry", async () => {
    let excTimeZone = "Asia/Shanghai";
    let now = new Date("2026-11-19T10:55:00.000Z");
    let advancePastSlotOnLock = false;

    const mathBefore = {
      taskId: MATH_ID,
      start: "2026-11-19T11:15:00.000Z",
      end: "2026-11-19T11:40:00.000Z",
      reason: "planned",
    };

    const sql = createMockSql((query) => {
      if (query.includes("pg_advisory_xact_lock") || query.includes("opening_workspace_history_revisions")) return [];
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: { dailyMinutes: 90, bufferMinutes: 15, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
          planning_settings: {
            weekOneMonday: "2026-09-07",
            periodTimes: {},
            dailyWindow: { start: "07:30", end: "22:30" },
            lunch: { start: "12:00", end: "12:45" },
            dinner: { start: "18:00", end: "18:45" },
            sleep: { start: "23:00", end: "07:00" },
            timeZone: "Asia/Shanghai",
          },
        }];
      }
      if (query.includes("FROM workspaces")) return [{ id: WS_A }];
      if (query.includes("FROM workspace_preferences")) {
        return [{
          planning_settings: {
            weekOneMonday: "2026-09-07",
            periodTimes: {},
            dailyWindow: { start: "07:30", end: "22:30" },
            lunch: { start: "12:00", end: "12:45" },
            dinner: { start: "18:00", end: "18:45" },
            sleep: { start: "23:00", end: "07:00" },
            timeZone: "Asia/Shanghai",
          },
        }];
      }
      if (query.includes("FROM opening_plan_acceptances")) return [];
      if (query.includes("FROM opening_plan_state")) {
        return [{ day: "2026-11-19", accepted_version: 1, accepted_blocks: [mathBefore], hard_blocks_fingerprint: "" }];
      }
      if (query.includes("FROM opening_plan_drafts") && query.includes("strategy_version")) {
        return [{
          id: EXC_ID,
          version: 1,
          input_snapshot: {
            dayException: {
              kind: DAY_EXCEPTION_SNAPSHOT_KIND,
              clientKey: "12121212-1212-4121-8121-121212121212",
              localDate: "2026-11-19",
              timeZone: excTimeZone,
              effectiveAt: "2026-11-19T10:55:00.000Z",
              remainingMinutes: 15,
              expectedExceptionRevision: 0,
              revision: 1,
            },
          },
        }];
      }
      if (query.includes("FROM opening_teaching_activities")) return [];
      if (query.includes("FROM opening_retest_activities")) {
        if (advancePastSlotOnLock) now = new Date("2026-11-19T11:20:00.000Z");
        return [];
      }
      if (query.includes("SELECT DISTINCT course_id")) return [];
      if (query.includes("FROM opening_tasks")) {
        return [
          {
            id: MATH_ID,
            workspace_id: WS_A,
            owner_user_id: OWNER_A,
            title: "高数",
            minutes: 25,
            status: "pending",
            version: 1,
            priority: 1,
            due_at: null,
            not_before: null,
            course_id: null,
            candidate_id: null,
          },
          {
            id: WRITING_ID,
            workspace_id: WS_A,
            owner_user_id: OWNER_A,
            title: "写作",
            minutes: 15,
            status: "pending",
            version: 1,
            priority: 2,
            due_at: null,
            not_before: null,
            course_id: null,
            candidate_id: null,
          },
        ];
      }
      return [];
    });

    const repo = createOpeningDayAdjustmentRepository(sql, { clock: () => now });
    const baseConfirm: DayAdjustmentConfirmInput = {
      clientKey: "day-adjust:p1-guards",
      sourceDate: "2026-11-19",
      expectedTimeZone: "Asia/Shanghai",
      expectedExceptionRevision: 1,
      expectedBudgetRevision: 1,
      expectedSourceAcceptedVersion: 1,
      expectedTargetAcceptedVersion: 0,
      expectedTaskRevisions: [
        { taskId: MATH_ID, version: 1 },
        { taskId: WRITING_ID, version: 1 },
      ],
      expectedRetestRevisions: [],
      sourceActions: {
        keptBlocks: [],
        removedBlocks: [mathBefore],
        addedBlocks: [
          {
            taskId: WRITING_ID,
            start: "2026-11-19T11:05:00.000Z",
            end: "2026-11-19T11:20:00.000Z",
            reason: "planned",
          },
        ],
      },
      targetActions: {
        targetDate: "2026-11-20",
        addedBlocks: [
          {
            taskId: MATH_ID,
            start: "2026-11-20T11:15:00.000Z",
            end: "2026-11-20T11:40:00.000Z",
            reason: "planned",
          },
        ],
      },
    };

    // 1. dayException.timeZone drift rejected
    excTimeZone = "UTC";
    await expect(
      repo.confirm({ workspaceId: WS_A, ownerUserId: OWNER_A }, baseConfirm),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "stale_version" });
    excTimeZone = "Asia/Shanghai";

    // 2. Same task in both sourceDay.addedBlocks and targetDay.addedBlocks rejected
    await expect(
      repo.confirm({ workspaceId: WS_A, ownerUserId: OWNER_A }, {
        ...baseConfirm,
        sourceActions: {
          keptBlocks: [],
          removedBlocks: [mathBefore],
          addedBlocks: [
            {
              taskId: MATH_ID,
              start: "2026-11-19T11:05:00.000Z",
              end: "2026-11-19T11:30:00.000Z",
              reason: "planned",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "stale_version" });

    // 3. Clock advancing past sourceAddedBlocks[0].start while acquiring locks => 409 slot_expired
    advancePastSlotOnLock = true;
    await expect(
      repo.confirm({ workspaceId: WS_A, ownerUserId: OWNER_A }, baseConfirm),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "slot_expired" });
  });

  it("buffers quick-slot start inside an in-progress gap so manual confirm 30s after preview succeeds", async () => {
    let now = new Date("2026-11-19T10:55:20.000Z"); // 18:55:20 Asia/Shanghai (inside free gap)
    const planningSettings = {
      weekOneMonday: "2026-09-07",
      periodTimes: {},
      dailyWindow: { start: "07:30", end: "22:30" },
      lunch: { start: "12:00", end: "12:45" },
      dinner: { start: "18:00", end: "18:45" },
      sleep: { start: "23:00", end: "07:00" },
      timeZone: "Asia/Shanghai",
    };
    const sql = createMockSql((query, values) => {
      if (query.includes("pg_advisory_xact_lock") || query.includes("opening_workspace_history_revisions")) return [];
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: { dailyMinutes: 90, bufferMinutes: 15, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
          planning_settings: planningSettings,
        }];
      }
      if (query.includes("FROM workspaces")) return [{ id: WS_A }];
      if (query.includes("FROM workspace_preferences")) return [{ planning_settings: planningSettings }];
      if (query.includes("FROM opening_plan_drafts") && query.includes("strategy_version")) {
        if (values[2] !== "2026-11-19") return [];
        return [{
          id: EXC_ID,
          version: 1,
          input_snapshot: {
            dayException: {
              kind: DAY_EXCEPTION_SNAPSHOT_KIND,
              clientKey: "12121212-1212-4121-8121-121212121212",
              localDate: "2026-11-19",
              timeZone: "Asia/Shanghai",
              effectiveAt: "2026-11-19T10:55:00.000Z",
              remainingMinutes: 15,
              expectedExceptionRevision: 0,
              revision: 1,
            },
          },
        }];
      }
      if (query.includes("SELECT DISTINCT course_id")) return [];
      if (query.includes("FROM opening_tasks")) {
        return [{
          id: WRITING_ID,
          workspace_id: WS_A,
          owner_user_id: OWNER_A,
          title: "单词速记",
          minutes: 15,
          status: "pending",
          version: 1,
          priority: 1,
          due_at: null,
          not_before: null,
          course_id: null,
          candidate_id: null,
        }];
      }
      if (query.includes("FROM opening_plan_state")) return [];
      if (query.includes("FROM opening_plan_acceptances")) return [];
      if (query.includes("FROM opening_teaching_activities")) return [];
      if (query.includes("FROM opening_retest_activities")) return [];
      if (query.includes("FROM opening_hard_blocks") || query.includes("FROM opening_timetable_sessions")) return [];
      if (query.includes("INSERT INTO")) return [];
      return [];
    });

    const repo = createOpeningDayAdjustmentRepository(sql, { clock: () => now });
    const preview = await repo.preview(
      { workspaceId: WS_A, ownerUserId: OWNER_A },
      { date: "2026-11-19", quickTaskId: WRITING_ID },
    );
    expect(preview.status).toBe("ready");
    expect(preview.canConfirm).toBe(true);
    expect(preview.sourceAddedBlocks).toHaveLength(1);
    expect(Date.parse(preview.sourceAddedBlocks[0]!.start)).toBeGreaterThanOrEqual(now.getTime() + 60_000);

    // Advance clock +30 seconds (realistic human confirmation latency) -> Tx2 confirm succeeds!
    now = new Date(now.getTime() + 30_000);
    const receipt = await repo.confirm(
      { workspaceId: WS_A, ownerUserId: OWNER_A },
      {
        clientKey: "day-adjust:buffered-confirm",
        sourceDate: "2026-11-19",
        expectedTimeZone: "Asia/Shanghai",
        expectedExceptionRevision: preview.exceptionRevision,
        expectedBudgetRevision: preview.budgetRevision,
        expectedSourceAcceptedVersion: preview.sourceAcceptedVersion,
        expectedTaskRevisions: preview.taskRevisions,
        expectedRetestRevisions: preview.retestRevisions,
        sourceActions: {
          keptBlocks: preview.keptBlocks,
          removedBlocks: preview.removedBlocks,
          addedBlocks: preview.sourceAddedBlocks,
        },
        targetActions: null,
      },
    );
    expect(receipt.replayed).toBe(false);
    expect(receipt.sourceBlocks).toEqual(preview.sourceAddedBlocks);
  });
});

describe("assertOpeningLearningManagementDraft day-adjustment isolation guard", () => {
  const scope = { workspaceId: WS_A, ownerUserId: OWNER_A };
  const unusedTx = (() => {
    throw new Error("should reject before hitting DB");
  }) as unknown as Parameters<typeof assertOpeningLearningManagementDraft>[0];

  it.each([
    { strategy_version: DAY_EXCEPTION_STRATEGY_VERSION, input_snapshot: {} },
    { strategy_version: DAY_ADJUSTMENT_STRATEGY_VERSION, input_snapshot: {} },
    { strategy_version: null, input_snapshot: { dayException: { kind: "day_exception_v1" } } },
    { strategy_version: null, input_snapshot: { dayAdjustment: { kind: "day_adjustment_v1" } } },
    { strategy_version: null, input_snapshot: {}, reasons: { dayException: { kind: "day_exception_v1" } } },
    { strategy_version: null, input_snapshot: {}, reasons: { dayAdjustment: { kind: "day_adjustment_v1" } } },
    { strategy_version: null, input_snapshot: {}, propose_client_key: `${DAY_EXCEPTION_PROPOSE_KEY_PREFIX}abc` },
    { strategy_version: null, input_snapshot: {}, propose_client_key: `${DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX}abc` },
  ])("rejects ordinary accept bypass for %j", async (draft) => {
    await expect(
      assertOpeningLearningManagementDraft(unusedTx, scope, draft, new Date()),
    ).rejects.toBeInstanceOf(OpeningPlanError);
  });

  it("rejects ordinary acceptPlan fresh blocks starting before active dayException.effectiveAt", async () => {
    const tx = createMockSql((query) => {
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: { dailyMinutes: 90, bufferMinutes: 15, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
          planning_settings: {
            weekOneMonday: "2026-09-07",
            periodTimes: {},
            dailyWindow: { start: "07:30", end: "22:30" },
            lunch: { start: "12:00", end: "12:45" },
            dinner: { start: "18:00", end: "18:45" },
            sleep: { start: "23:00", end: "07:00" },
            timeZone: "Asia/Shanghai",
          },
        }];
      }
      if (query.includes("FROM opening_plan_drafts") && query.includes("strategy_version")) {
        return [{
          id: EXC_ID,
          version: 1,
          input_snapshot: {
            dayException: {
              kind: DAY_EXCEPTION_SNAPSHOT_KIND,
              clientKey: "12121212-1212-4121-8121-121212121212",
              localDate: "2026-11-19",
              timeZone: "Asia/Shanghai",
              effectiveAt: "2026-11-19T11:00:00.000Z",
              remainingMinutes: 15,
              expectedExceptionRevision: 0,
              revision: 1,
            },
          },
        }];
      }
      if (query.includes("SELECT DISTINCT course_id")) return [];
      if (query.includes("FROM opening_tasks")) {
        return [{ id: WRITING_ID, status: "pending", minutes: 15 }];
      }
      return [];
    }) as unknown as Parameters<typeof assertOpeningLearningManagementDraft>[0];

    await expect(
      assertOpeningLearningManagementDraft(
        tx,
        scope,
        {
          day: "2026-11-19",
          strategy_version: null,
          input_snapshot: {},
          suggested_tasks: [],
          blocks: [
            {
              taskId: WRITING_ID,
              start: "2026-11-19T10:30:00.000Z", // before effectiveAt 11:00Z!
              end: "2026-11-19T10:45:00.000Z",
              reason: "planned",
            },
          ],
        },
        new Date("2026-11-19T11:05:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "slot_expired" });
  });
});
