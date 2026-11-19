import { describe, expect, it } from "vitest";
import {
  DAY_ADJUSTMENT_STRATEGY_VERSION,
  DAY_EXCEPTION_STRATEGY_VERSION,
  type DayAdjustmentConfirmInput,
} from "@aistudy/contracts";
import { computeDayAdjustmentConfirmPayloadHash } from "./opening-day-adjustment";
import {
  calculateDayExceptionUsageBounds,
  evaluateDayPlanCapacity,
} from "./opening-learning-capacity-usage";
import { assertOpeningLearningManagementDraft } from "./opening-learning-management-draft";
import { OpeningPlanError } from "./opening-plan-error";

const WRITING_ID = "55555555-5555-4555-8555-555555555555";
const MATH_ID = "66666666-6666-4666-8666-666666666666";
const RETEST_ID = "77777777-7777-4777-8777-777777777777";

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

describe("assertOpeningLearningManagementDraft day-adjustment isolation guard", () => {
  const scope = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "22222222-2222-4222-8222-222222222222",
  };
  const unusedTx = (() => {
    throw new Error("should reject before hitting DB");
  }) as unknown as Parameters<typeof assertOpeningLearningManagementDraft>[0];

  it.each([
    { strategy_version: DAY_EXCEPTION_STRATEGY_VERSION, input_snapshot: {} },
    { strategy_version: DAY_ADJUSTMENT_STRATEGY_VERSION, input_snapshot: {} },
    { strategy_version: null, input_snapshot: { dayException: { kind: "day_exception_v1" } } },
    { strategy_version: null, input_snapshot: { dayAdjustment: { kind: "day_adjustment_v1" } } },
  ])("rejects ordinary accept bypass for %j", async (draft) => {
    await expect(
      assertOpeningLearningManagementDraft(unusedTx, scope, draft, new Date()),
    ).rejects.toBeInstanceOf(OpeningPlanError);
  });
});
