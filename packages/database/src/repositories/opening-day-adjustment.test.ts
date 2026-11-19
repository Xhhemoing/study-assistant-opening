import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX,
  DAY_ADJUSTMENT_STRATEGY_VERSION,
  DAY_EXCEPTION_PROPOSE_KEY_PREFIX,
  DAY_EXCEPTION_SNAPSHOT_KIND,
  DAY_EXCEPTION_STRATEGY_VERSION,
  conversationPlanInputSchema,
  dayExceptionReceiptSchema,
  learningManagementCommandSchema,
  localReplanInputSchema,
  ordinaryPlanClientKeySchema,
  type DayAdjustmentConfirmInput,
} from "@aistudy/contracts";
import {
  computeDayAdjustmentConfirmPayloadHash,
  createOpeningDayAdjustmentRepository,
} from "./opening-day-adjustment";
import { assertOpeningWorkspaceCapacity } from "./opening-learning-capacity";
import {
  calculateDayExceptionUsageBounds,
  evaluateDayPlanCapacity,
} from "./opening-learning-capacity-usage";
import { assertOpeningLearningManagementDraft } from "./opening-learning-management-draft";
import { OpeningPlanError } from "./opening-plan-error";
import { createOpeningPlansRepository } from "./opening-plans";

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

    const sql = createMockSql((query, values) => {
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
        if (values[2] !== "2026-11-19") return [];
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
    { strategy_version: null, input_snapshot: {}, propose_client_key: `${DAY_EXCEPTION_PROPOSE_KEY_PREFIX}${EXC_ID}` },
    { strategy_version: null, input_snapshot: {}, propose_client_key: `${DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX}${WRITING_ID}` },
  ])("rejects ordinary accept bypass for %j", async (draft) => {
    await expect(
      assertOpeningLearningManagementDraft(unusedTx, scope, draft, new Date()),
    ).rejects.toBeInstanceOf(OpeningPlanError);
  });

  it("allows legacy non-UUID day-adjustment prefix and legacy local-replan-v1 UUID keys while blocking reserved prefixes on new command schemas", async () => {
    const emptyTx = createMockSql((query) => {
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: null,
          planning_settings: null,
        }];
      }
      return [];
    }) as unknown as Parameters<typeof assertOpeningLearningManagementDraft>[0];

    await expect(
      assertOpeningLearningManagementDraft(
        emptyTx,
        scope,
        {
          day: "2026-11-19",
          strategy_version: null,
          input_snapshot: {},
          suggested_tasks: [],
          blocks: [],
          propose_client_key: `${DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX}legacy-key-1`,
        },
        new Date("2026-11-19T11:05:00.000Z"),
      ),
    ).resolves.toBeUndefined();

    await expect(
      assertOpeningLearningManagementDraft(
        emptyTx,
        scope,
        {
          day: "2026-11-19",
          strategy_version: "local-replan-v1",
          input_snapshot: {},
          suggested_tasks: [],
          blocks: [],
          propose_client_key: `${DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX}${WRITING_ID}`,
        },
        new Date("2026-11-19T11:05:00.000Z"),
      ),
    ).resolves.toBeUndefined();

    // New ordinary command schemas reject reserved prefixes.
    expect(
      localReplanInputSchema.safeParse({
        date: "2026-11-19",
        clientKey: `${DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX}custom-1`,
      }).success,
    ).toBe(false);
    expect(
      learningManagementCommandSchema.safeParse({
        action: "preview",
        date: "2026-11-19",
        clientKey: `${DAY_EXCEPTION_PROPOSE_KEY_PREFIX}custom-1`,
      }).success,
    ).toBe(false);
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

describe("closing boundary P1 & P2/P3 guards", () => {
  const scope = { workspaceId: WS_A, ownerUserId: OWNER_A };
  const planningSettings = {
    weekOneMonday: "2026-09-07",
    periodTimes: {},
    dailyWindow: { start: "07:30", end: "22:30" },
    lunch: { start: "12:00", end: "12:45" },
    dinner: { start: "18:00", end: "18:45" },
    sleep: { start: "23:00", end: "07:00" },
    timeZone: "Asia/Shanghai",
  };

  it("P1-1: counts cross-day spillover blocks from another day row after timezone switch in target overlap and budget checks", async () => {
    const SPILL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    // Stored under 2026-11-19 row (e.g. old America/Los_Angeles Thu evening), actually falls on 2026-11-20 09:00-09:25 Asia/Shanghai!
    const thuRetainedSpilloverBlock = {
      taskId: SPILL_ID,
      start: "2026-11-20T01:00:00.000Z",
      end: "2026-11-20T01:25:00.000Z",
      reason: "planned",
    };
    const mathBlock = {
      taskId: MATH_ID,
      start: "2026-11-19T11:15:00.000Z",
      end: "2026-11-19T11:40:00.000Z",
      reason: "planned",
    };
    const now = new Date("2026-11-19T10:55:00.000Z");

    const sql = createMockSql((query, values) => {
      if (query.includes("pg_advisory_xact_lock") || query.includes("opening_workspace_history_revisions")) return [];
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          // Net daily budget = 55 - 15 = 40m; spillover 25m + moved math 25m = 50m > 40m (shortfall 10m).
          learning_management: { dailyMinutes: 55, bufferMinutes: 15, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
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
      if (query.includes("FROM opening_plan_state")) {
        if (query.includes("day = ANY(") || query.includes("day>=")) {
          return [
            { day: "2026-11-19", accepted_version: 1, accepted_blocks: [mathBlock, thuRetainedSpilloverBlock], hard_blocks_fingerprint: "" },
          ];
        }
        const day = String(values[1]);
        if (day === "2026-11-19") {
          return [{ accepted_version: 1, accepted_blocks: [mathBlock, thuRetainedSpilloverBlock] }];
        }
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
            id: SPILL_ID,
            workspace_id: WS_A,
            owner_user_id: OWNER_A,
            title: "跨时区晚间块",
            minutes: 25,
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
    // Preview: requesting Fri 01:00Z (overlaps spillover block) must NOT overlap it, AND budget shortfall is detected!
    const preview = await repo.preview(scope, {
      date: "2026-11-19",
      targetDate: "2026-11-20",
      moveTaskIds: [MATH_ID],
      targetStartAt: "2026-11-20T01:00:00.000Z",
    });
    expect(preview.targetAddedBlocks).toEqual([]);
    expect(preview.unplacedMoveTaskIds).toEqual([MATH_ID]);
    expect(preview.canConfirm).toBe(false);

    // Preview on a non-overlapping Fri slot still detects 10m budget overflow (25m spillover + 25m moved > 40m).
    const previewOverflow = await repo.preview(scope, {
      date: "2026-11-19",
      targetDate: "2026-11-20",
      moveTaskIds: [MATH_ID],
      targetStartAt: "2026-11-20T02:00:00.000Z",
    });
    expect(previewOverflow.targetCapacityAfter?.shortfallMinutes).toBe(10);
    expect(previewOverflow.canConfirm).toBe(false);

    // Confirm overlapping the spillover block is rejected.
    await expect(
      repo.confirm(scope, {
        clientKey: "day-adjust:spill-overlap",
        sourceDate: "2026-11-19",
        expectedTimeZone: "Asia/Shanghai",
        expectedExceptionRevision: 1,
        expectedBudgetRevision: 1,
        expectedSourceAcceptedVersion: 1,
        expectedTargetAcceptedVersion: 0,
        expectedTaskRevisions: [
          { taskId: MATH_ID, version: 1 },
          { taskId: SPILL_ID, version: 1 },
        ],
        expectedRetestRevisions: [],
        sourceActions: {
          keptBlocks: [thuRetainedSpilloverBlock],
          removedBlocks: [mathBlock],
          addedBlocks: [],
        },
        targetActions: {
          targetDate: "2026-11-20",
          addedBlocks: [
            {
              taskId: MATH_ID,
              start: "2026-11-20T01:00:00.000Z",
              end: "2026-11-20T01:25:00.000Z",
              reason: "planned",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "stale_version" });

    // Confirm on a non-overlapping Fri slot that exceeds budget (25m + 25m > 40m) is also rejected.
    await expect(
      repo.confirm(scope, {
        clientKey: "day-adjust:spill-budget",
        sourceDate: "2026-11-19",
        expectedTimeZone: "Asia/Shanghai",
        expectedExceptionRevision: 1,
        expectedBudgetRevision: 1,
        expectedSourceAcceptedVersion: 1,
        expectedTargetAcceptedVersion: 0,
        expectedTaskRevisions: [
          { taskId: MATH_ID, version: 1 },
          { taskId: SPILL_ID, version: 1 },
        ],
        expectedRetestRevisions: [],
        sourceActions: {
          keptBlocks: [thuRetainedSpilloverBlock],
          removedBlocks: [mathBlock],
          addedBlocks: [],
        },
        targetActions: {
          targetDate: "2026-11-20",
          addedBlocks: [
            {
              taskId: MATH_ID,
              start: "2026-11-20T02:00:00.000Z",
              end: "2026-11-20T02:25:00.000Z",
              reason: "planned",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "stale_version" });
  });

  it("P1-2: enforces snoozed_until and deadline_at for non-course-route retest tasks in quick-slot preview and Tx2 confirm", async () => {
    const now = new Date("2026-11-19T10:55:00.000Z");
    const snoozedUntil = "2026-11-19T13:00:00.000Z"; // 21:00 Asia/Shanghai
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
      if (query.includes("FROM opening_retest_activities")) {
        return [{
          id: RETEST_ID,
          task_id: WRITING_ID,
          course_id: null,
          status: "accepted",
          version: 1,
          scheduled_start_at: null,
          recommended_at: null,
          not_before_at: null,
          snoozed_until: snoozedUntil,
          deadline_at: "2026-11-19T14:00:00.000Z",
          learning_protocol: null,
        }];
      }
      if (query.includes("SELECT DISTINCT course_id")) return [];
      if (query.includes("FROM opening_tasks")) {
        return [{
          id: WRITING_ID,
          workspace_id: WS_A,
          owner_user_id: OWNER_A,
          title: "非路线复测",
          minutes: 15,
          status: "pending",
          version: 1,
          priority: 1,
          due_at: null,
          not_before: null,
          course_id: null,
          candidate_id: null,
          retest_activity_id: RETEST_ID,
          retest_workspace_id: WS_A,
          retest_owner_user_id: OWNER_A,
          retest_task_id: WRITING_ID,
          retest_course_id: null,
          retest_purpose: "retest",
          retest_status: "accepted",
          retest_version: 1,
          retest_learning_protocol: null,
          retest_not_before_at: null,
          retest_recommended_at: null,
          retest_scheduled_start_at: null,
          retest_snoozed_until: snoozedUntil,
          retest_deadline_at: "2026-11-19T14:00:00.000Z",
        }];
      }
      return [];
    });

    const repo = createOpeningDayAdjustmentRepository(sql, { clock: () => now });
    // Preview quickCandidate must NOT suggest a slot earlier than snoozed_until (13:00Z).
    const preview = await repo.preview(scope, {
      date: "2026-11-19",
      quickTaskId: WRITING_ID,
      quickStartAt: "2026-11-19T11:15:00.000Z",
    });
    expect(preview.sourceAddedBlocks).toEqual([]);
    expect(preview.canConfirm).toBe(false);
    const candidate = preview.quickCandidates.find((c) => c.taskId === WRITING_ID);
    expect(candidate?.fits).toBe(true);
    expect(Date.parse(candidate!.suggestedSlot!.start)).toBeGreaterThanOrEqual(Date.parse(snoozedUntil));

    // Tx2 confirm placing quick slot before snoozed_until is rejected.
    await expect(
      repo.confirm(scope, {
        clientKey: "day-adjust:retest-snooze-bypass",
        sourceDate: "2026-11-19",
        expectedTimeZone: "Asia/Shanghai",
        expectedExceptionRevision: 1,
        expectedBudgetRevision: 1,
        expectedSourceAcceptedVersion: 0,
        expectedTaskRevisions: [{ taskId: WRITING_ID, version: 1 }],
        expectedRetestRevisions: [],
        sourceActions: {
          keptBlocks: [],
          removedBlocks: [],
          addedBlocks: [
            {
              taskId: WRITING_ID,
              start: "2026-11-19T11:15:00.000Z",
              end: "2026-11-19T11:30:00.000Z",
              reason: "planned",
            },
          ],
        },
        targetActions: null,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
  });

  it("P1-5: caps quickCandidates to 200 deterministically when workspace has >200 pending tasks", async () => {
    const now = new Date("2026-11-19T10:55:00.000Z");
    const manyTasks = Array.from({ length: 205 }, (_, index) => {
      const hex = String(index + 1).padStart(12, "0");
      return {
        id: `00000000-0000-4000-8000-${hex}`,
        workspace_id: WS_A,
        owner_user_id: OWNER_A,
        title: `任务 ${index + 1}`,
        minutes: 15,
        status: "pending",
        version: 1,
        priority: 1,
        due_at: null,
        not_before: null,
        course_id: null,
        candidate_id: null,
      };
    });
    const lastTaskId = manyTasks[204]!.id;

    const sql = createMockSql((query, values) => {
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: { dailyMinutes: 90, bufferMinutes: 15, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
          planning_settings: planningSettings,
        }];
      }
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
      if (query.includes("FROM opening_tasks")) return manyTasks;
      return [];
    });

    const repo = createOpeningDayAdjustmentRepository(sql, { clock: () => now });
    const preview = await repo.preview(scope, {
      date: "2026-11-19",
      quickTaskId: lastTaskId,
    });
    expect(preview.quickCandidates).toHaveLength(200);
    expect(preview.quickCandidates.some((c) => c.taskId === lastTaskId)).toBe(true);
    expect(preview.sourceAddedBlocks[0]?.taskId).toBe(lastTaskId);
  });

  it("P2/P3-2: skips and rejects quick-slot scheduling for a task already scheduled on the target day", async () => {
    const now = new Date("2026-11-19T10:55:00.000Z");
    const mathBlock = {
      taskId: MATH_ID,
      start: "2026-11-19T11:15:00.000Z",
      end: "2026-11-19T11:40:00.000Z",
      reason: "planned",
    };
    const writingOnFri = {
      taskId: WRITING_ID,
      start: "2026-11-20T11:00:00.000Z",
      end: "2026-11-20T11:15:00.000Z",
      reason: "planned",
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
      if (query.includes("FROM opening_plan_state")) {
        if (query.includes("day = ANY(") || query.includes("day>=")) {
          return [
            { day: "2026-11-19", accepted_version: 1, accepted_blocks: [mathBlock], hard_blocks_fingerprint: "" },
            { day: "2026-11-20", accepted_version: 1, accepted_blocks: [writingOnFri], hard_blocks_fingerprint: "" },
          ];
        }
        const day = String(values[1]);
        if (day === "2026-11-19") return [{ accepted_version: 1, accepted_blocks: [mathBlock] }];
        if (day === "2026-11-20") return [{ accepted_version: 1, accepted_blocks: [writingOnFri] }];
        return [];
      }
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
    const preview = await repo.preview(scope, {
      date: "2026-11-19",
      targetDate: "2026-11-20",
      quickTaskId: WRITING_ID,
    });
    expect(preview.quickCandidates.some((c) => c.taskId === WRITING_ID)).toBe(false);
    expect(preview.sourceAddedBlocks).toEqual([]);
    expect(preview.blockers.some((b) => b.includes("2026-11-20"))).toBe(true);

    await expect(
      repo.confirm(scope, {
        clientKey: "day-adjust:cross-day-dup",
        sourceDate: "2026-11-19",
        expectedTimeZone: "Asia/Shanghai",
        expectedExceptionRevision: 1,
        expectedBudgetRevision: 1,
        expectedSourceAcceptedVersion: 1,
        expectedTargetAcceptedVersion: 1,
        expectedTaskRevisions: [
          { taskId: MATH_ID, version: 1 },
          { taskId: WRITING_ID, version: 1 },
        ],
        expectedRetestRevisions: [],
        sourceActions: {
          keptBlocks: [],
          removedBlocks: [mathBlock],
          addedBlocks: [
            {
              taskId: WRITING_ID,
              start: "2026-11-19T11:15:00.000Z",
              end: "2026-11-19T11:30:00.000Z",
              reason: "planned",
            },
          ],
        },
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
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "stale_version" });
  });

  it("P2/P3-3: assertOpeningWorkspaceCapacity rejects when active dayException timeZone differs from workspace timeZone", async () => {
    const tx = createMockSql((query) => {
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: { dailyMinutes: 90, bufferMinutes: 15, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
          planning_settings: planningSettings,
        }];
      }
      if (query.includes("FROM workspaces")) return [{ id: WS_A }];
      if (query.includes("FROM opening_plan_drafts") && query.includes("strategy_version")) {
        return [{
          id: EXC_ID,
          version: 1,
          input_snapshot: {
            dayException: {
              kind: DAY_EXCEPTION_SNAPSHOT_KIND,
              clientKey: "12121212-1212-4121-8121-121212121212",
              localDate: "2026-11-19",
              timeZone: "UTC", // drifted from Asia/Shanghai!
              effectiveAt: "2026-11-19T10:55:00.000Z",
              remainingMinutes: 15,
              expectedExceptionRevision: 0,
              revision: 1,
            },
          },
        }];
      }
      return [];
    }) as unknown as Parameters<typeof assertOpeningWorkspaceCapacity>[0];

    await expect(
      assertOpeningWorkspaceCapacity(
        tx,
        scope,
        { minutes: 10, targetAt: new Date("2026-11-19T11:00:00.000Z") },
        new Date("2026-11-19T11:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("P1-1: ordinary plan confirmation counts cross-day spillover kept blocks under active dayException after timezone shift", async () => {
    // Old timezone row (day = 2026-11-18) has a 10m block at 11:05Z-11:15Z (19:05-19:15 Asia/Shanghai on 2026-11-19).
    const spilloverBlock = {
      taskId: MATH_ID,
      start: "2026-11-19T11:05:00.000Z",
      end: "2026-11-19T11:15:00.000Z",
      reason: "planned",
    };
    const tx = createMockSql((query, values) => {
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: { dailyMinutes: 90, bufferMinutes: 15, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
          planning_settings: planningSettings,
        }];
      }
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
              effectiveAt: "2026-11-19T11:00:00.000Z",
              remainingMinutes: 15,
              expectedExceptionRevision: 0,
              revision: 1,
            },
          },
        }];
      }
      if (query.includes("FROM opening_plan_state")) {
        return [{ day: "2026-11-18", accepted_blocks: [spilloverBlock] }];
      }
      if (query.includes("SELECT DISTINCT course_id")) return [];
      if (query.includes("FROM opening_tasks")) {
        return [
          { id: MATH_ID, status: "pending", minutes: 10 },
          { id: WRITING_ID, status: "pending", minutes: 10 },
          { id: DUE_TODAY_ID, status: "pending", minutes: 5 },
        ];
      }
      return [];
    }) as unknown as Parameters<typeof assertOpeningLearningManagementDraft>[0];

    // Adding a non-overlapping 10m block on 2026-11-19 brings post-effectiveAt total to 10 + 10 = 20m > 15m -> rejected!
    await expect(
      assertOpeningLearningManagementDraft(
        tx,
        scope,
        {
          day: "2026-11-19",
          strategy_version: null,
          input_snapshot: { tasks: [], free: [], proposedAt: "2026-11-19T11:01:00.000Z", unscheduledReasons: [] },
          suggested_tasks: [],
          blocks: [
            {
              taskId: WRITING_ID,
              start: "2026-11-19T11:20:00.000Z",
              end: "2026-11-19T11:30:00.000Z",
              reason: "planned",
            },
          ],
        },
        new Date("2026-11-19T11:02:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "stale_version" });

    // Adding a 5m block brings post-effectiveAt total to 10 + 5 = 15m <= 15m -> allowed!
    await expect(
      assertOpeningLearningManagementDraft(
        tx,
        scope,
        {
          day: "2026-11-19",
          strategy_version: null,
          input_snapshot: { tasks: [], free: [], proposedAt: "2026-11-19T11:01:00.000Z", unscheduledReasons: [] },
          suggested_tasks: [],
          blocks: [
            {
              taskId: DUE_TODAY_ID,
              start: "2026-11-19T11:20:00.000Z",
              end: "2026-11-19T11:25:00.000Z",
              reason: "planned",
            },
          ],
        },
        new Date("2026-11-19T11:02:00.000Z"),
      ),
    ).resolves.toBeUndefined();
  });

  it("P1-3: enforces case-insensitive reserved prefixes on creation while allowing legacy ordinary drafts with reserved UUID keys", async () => {
    const upperAdjKey = `DAY-ADJUSTMENT:${WRITING_ID}`;
    const upperExcKey = `Day-Exception:${EXC_ID}`;

    // 1. Case-insensitive rejection across all ordinary command schemas & opening-plans.proposePlan.
    expect(ordinaryPlanClientKeySchema.safeParse(upperAdjKey).success).toBe(false);
    expect(ordinaryPlanClientKeySchema.safeParse(upperExcKey).success).toBe(false);
    expect(
      localReplanInputSchema.safeParse({ date: "2026-11-19", clientKey: upperAdjKey }).success,
    ).toBe(false);
    expect(
      learningManagementCommandSchema.safeParse({
        action: "preview",
        date: "2026-11-19",
        expectedAcceptedVersion: 0,
        expectedBudgetRevision: 1,
        clientKey: upperExcKey,
      }).success,
    ).toBe(false);
    expect(
      conversationPlanInputSchema.safeParse({
        candidateId: MATH_ID,
        expectedVersion: 0,
        date: "2026-11-19",
        expectedAcceptedVersion: 0,
        clientKey: upperAdjKey,
      }).success,
    ).toBe(false);

    const plansRepo = createOpeningPlansRepository(
      createMockSql(() => []) as unknown as Sql,
    );
    await expect(
      plansRepo.proposePlan(scope, {
        date: "2026-11-19",
        clientKey: upperAdjKey,
        tasks: [],
        free: [],
        blocks: [],
        unscheduledTaskIds: [],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // 2. Legacy ordinary draft (strategy_version === null + ordinary proposePlan snapshot) with day-adjustment:<UUID> is allowed.
    const emptyTx = createMockSql((query) => {
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{ learning_management: null, planning_settings: null }];
      }
      return [];
    }) as unknown as Parameters<typeof assertOpeningLearningManagementDraft>[0];

    await expect(
      assertOpeningLearningManagementDraft(
        emptyTx,
        scope,
        {
          day: "2026-11-19",
          strategy_version: null,
          input_snapshot: {
            tasks: [],
            free: [],
            proposedAt: "2026-11-19T08:00:00.000Z",
            unscheduledReasons: [],
          },
          reasons: {},
          suggested_tasks: [],
          blocks: [],
          propose_client_key: `${DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX}${WRITING_ID}`,
        },
        new Date("2026-11-19T11:05:00.000Z"),
      ),
    ).resolves.toBeUndefined();

    // 3. Stripped adjustment draft without ordinary snapshot structure is still rejected.
    await expect(
      assertOpeningLearningManagementDraft(
        emptyTx,
        scope,
        {
          day: "2026-11-19",
          strategy_version: null,
          input_snapshot: {},
          reasons: {},
          suggested_tasks: [],
          blocks: [],
          propose_client_key: `${DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX}${WRITING_ID}`,
        },
        new Date("2026-11-19T11:05:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "stale_version" });
  });

  it("P1-4: preserves mutated task versions in 200-block source plan + remove 1 + add 1 quick task (201 IDs) so preview->confirm succeeds", async () => {
    const now = new Date("2026-11-19T10:55:00.000Z");
    const baseMs = Date.parse("2026-11-19T00:00:00.000Z"); // 08:00 Asia/Shanghai
    // 199 past 1-minute blocks (08:00..11:19 local, all ended before effectiveAt 18:55 local = 10:55Z)
    // + 1 future 20-minute block (19:00..19:20 local = 11:00Z..11:20Z) to be removed.
    const existingTasks = Array.from({ length: 200 }, (_, index) => {
      const hex = String(index + 1).padStart(12, "0");
      const id = `00000000-0000-4000-8000-${hex}`;
      const isLast = index === 199;
      return {
        id,
        workspace_id: WS_A,
        owner_user_id: OWNER_A,
        title: `既有任务 ${index + 1}`,
        minutes: isLast ? 20 : 1,
        status: "pending",
        version: 1,
        priority: 1,
        due_at: null,
        not_before: null,
        course_id: null,
        candidate_id: null,
      };
    });
    const removedTask = existingTasks[199]!;
    const quickTaskId = "ffffffff-ffff-4fff-8fff-ffffffffffff"; // sorts AFTER all 200 source tasks!
    const quickTask = {
      id: quickTaskId,
      workspace_id: WS_A,
      owner_user_id: OWNER_A,
      title: "15分钟快速巩固",
      minutes: 15,
      status: "pending",
      version: 3,
      priority: 2,
      due_at: null,
      not_before: null,
      course_id: null,
      candidate_id: null,
    };
    const allTasks = [...existingTasks, quickTask];
    const sourceBeforeBlocks = existingTasks.map((task, index) => {
      if (index === 199) {
        return {
          taskId: task.id,
          start: "2026-11-19T11:00:00.000Z",
          end: "2026-11-19T11:20:00.000Z",
          reason: "planned",
        };
      }
      const start = new Date(baseMs + index * 60_000).toISOString();
      const end = new Date(baseMs + (index + 1) * 60_000).toISOString();
      return { taskId: task.id, start, end, reason: "planned" };
    });

    const sql = createMockSql((query, values) => {
      if (query.includes("pg_advisory_xact_lock") || query.includes("opening_workspace_history_revisions")) return [];
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: null,
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
      if (query.includes("FROM opening_plan_state")) {
        if (query.includes("day = ANY(")) {
          return [{ day: "2026-11-19", accepted_version: 1, accepted_blocks: sourceBeforeBlocks, hard_blocks_fingerprint: "" }];
        }
        return [{ day: "2026-11-19", accepted_version: 1, accepted_blocks: sourceBeforeBlocks }];
      }
      if (query.includes("SELECT DISTINCT course_id")) return [];
      if (query.includes("FROM opening_tasks")) {
        if (query.includes("ANY(") && Array.isArray(values[2])) {
          const idSet = new Set(values[2] as string[]);
          return allTasks.filter((t) => idSet.has(t.id));
        }
        return allTasks;
      }
      return [];
    });

    const repo = createOpeningDayAdjustmentRepository(sql, { clock: () => now });
    const preview = await repo.preview(scope, {
      date: "2026-11-19",
      targetDate: null,
      removeTaskIds: [removedTask.id],
      quickTaskId,
    });
    expect(preview.canConfirm).toBe(true);
    expect(preview.removedBlocks).toHaveLength(1);
    expect(preview.sourceAddedBlocks).toHaveLength(1);
    expect(preview.sourceAddedBlocks[0]!.taskId).toBe(quickTaskId);
    expect(preview.taskRevisions).toHaveLength(201);
    expect(preview.taskRevisions.some((item) => item.taskId === removedTask.id)).toBe(true);
    expect(preview.taskRevisions.some((item) => item.taskId === quickTaskId && item.version === 3)).toBe(true);

    const receipt = await repo.confirm(scope, {
      clientKey: "day-adjust:200-blocks-plus-quick",
      sourceDate: preview.sourceDate,
      targetDate: preview.targetDate,
      expectedTimeZone: preview.timeZone,
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
    });
    expect(receipt.sourceAfterVersion).toBe(2);
    expect(receipt.sourceBlocks).toHaveLength(200);
    expect(receipt.sourceBlocks.some((b) => b.taskId === quickTaskId)).toBe(true);
    expect(receipt.sourceBlocks.some((b) => b.taskId === removedTask.id)).toBe(false);
  });

  it("P2: rejects source-only confirm adding a quick task already scheduled on targetDate even when targetActions is null", async () => {
    const now = new Date("2026-11-19T10:55:00.000Z");
    const mathBlock = {
      taskId: MATH_ID,
      start: "2026-11-19T11:15:00.000Z",
      end: "2026-11-19T11:40:00.000Z",
      reason: "planned",
    };
    const writingOnFri = {
      taskId: WRITING_ID,
      start: "2026-11-20T11:00:00.000Z",
      end: "2026-11-20T11:15:00.000Z",
      reason: "planned",
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
      if (query.includes("FROM opening_plan_state")) {
        if (query.includes("day = ANY(")) {
          return [
            { day: "2026-11-19", accepted_version: 1, accepted_blocks: [mathBlock], hard_blocks_fingerprint: "" },
            { day: "2026-11-20", accepted_version: 1, accepted_blocks: [writingOnFri], hard_blocks_fingerprint: "" },
          ];
        }
        return [
          { day: "2026-11-19", accepted_blocks: [mathBlock] },
          { day: "2026-11-20", accepted_blocks: [writingOnFri] },
        ];
      }
      return [];
    });

    const repo = createOpeningDayAdjustmentRepository(sql, { clock: () => now });
    await expect(
      repo.confirm(scope, {
        clientKey: "day-adjust:source-only-target-dup",
        sourceDate: "2026-11-19",
        targetDate: "2026-11-20",
        expectedTimeZone: "Asia/Shanghai",
        expectedExceptionRevision: 1,
        expectedBudgetRevision: 1,
        expectedSourceAcceptedVersion: 1,
        expectedTaskRevisions: [
          { taskId: MATH_ID, version: 1 },
          { taskId: WRITING_ID, version: 1 },
        ],
        expectedRetestRevisions: [],
        sourceActions: {
          keptBlocks: [],
          removedBlocks: [mathBlock],
          addedBlocks: [
            {
              taskId: WRITING_ID,
              start: "2026-11-19T11:15:00.000Z",
              end: "2026-11-19T11:30:00.000Z",
              reason: "planned",
            },
          ],
        },
        targetActions: null,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "stale_version" });
  });
});
