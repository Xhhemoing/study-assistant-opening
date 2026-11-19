import { describe, expect, it } from "vitest";
import {
  DAY_ADJUSTMENT_SNAPSHOT_KIND,
  DAY_ADJUSTMENT_STRATEGY_VERSION,
  DAY_EXCEPTION_SNAPSHOT_KIND,
  DAY_EXCEPTION_STRATEGY_VERSION,
} from "@aistudy/contracts";
import { validateBackupDayAdjustment } from "./backup-day-adjustment";
import {
  evaluateDayExceptionCapacity,
  findContinuousFreeSlot,
  straddlingUsageBounds,
} from "./long-term-planning";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const OTHER_OWNER = "99999999-9999-4999-8999-999999999999";
const EXC_ID = "33333333-3333-4333-8333-333333333333";
const ADJ_ID = "44444444-4444-4444-8444-444444444444";
const WRITING_ID = "55555555-5555-4555-8555-555555555555";
const MATH_ID = "66666666-6666-4666-8666-666666666666";
const RETEST_ID = "77777777-7777-4777-8777-777777777777";
const PAYLOAD_HASH = "a".repeat(64);

function validTables(): Record<string, Record<string, unknown>[]> {
  const writingBlock = {
    taskId: WRITING_ID,
    start: "2026-11-19T11:00:00.000Z", // 19:00 Asia/Shanghai
    end: "2026-11-19T11:15:00.000Z",
    reason: "planned",
  };
  const mathBefore = {
    taskId: MATH_ID,
    start: "2026-11-19T11:15:00.000Z",
    end: "2026-11-19T11:40:00.000Z",
    reason: "planned",
  };
  const mathFriday = {
    taskId: MATH_ID,
    start: "2026-11-20T11:15:00.000Z", // 19:15 Asia/Shanghai
    end: "2026-11-20T11:40:00.000Z",
    reason: "planned",
  };

  return {
    opening_tasks: [
      { id: WRITING_ID, workspace_id: WS, owner_user_id: OWNER, version: 1 },
      { id: MATH_ID, workspace_id: WS, owner_user_id: OWNER, version: 1 },
    ],
    opening_retest_activities: [
      {
        id: RETEST_ID,
        workspace_id: WS,
        owner_user_id: OWNER,
        task_id: MATH_ID,
        version: 2,
        scheduled_start_at: mathFriday.start,
      },
    ],
    opening_plan_state: [
      {
        workspace_id: WS,
        day: "2026-11-19",
        accepted_version: 2,
        accepted_blocks: [writingBlock],
      },
      {
        workspace_id: WS,
        day: "2026-11-20",
        accepted_version: 1,
        accepted_blocks: [mathFriday],
      },
    ],
    opening_plan_drafts: [
      {
        id: EXC_ID,
        workspace_id: WS,
        owner_user_id: OWNER,
        day: "2026-11-19",
        version: 1,
        base_version: 0,
        status: "accepted",
        blocks: [],
        suggested_tasks: [],
        origin: "user",
        propose_client_key: null,
        strategy_version: DAY_EXCEPTION_STRATEGY_VERSION,
        input_snapshot: {
          dayException: {
            kind: DAY_EXCEPTION_SNAPSHOT_KIND,
            localDate: "2026-11-19",
            timeZone: "Asia/Shanghai",
            effectiveAt: "2026-11-19T10:55:00.000Z",
            remainingMinutes: 15,
            expectedExceptionRevision: 0,
            revision: 1,
          },
        },
      },
      {
        id: ADJ_ID,
        workspace_id: WS,
        owner_user_id: OWNER,
        day: "2026-11-19",
        version: 2,
        base_version: 1,
        status: "accepted",
        blocks: [writingBlock],
        suggested_tasks: [],
        origin: "user",
        propose_client_key: null,
        strategy_version: DAY_ADJUSTMENT_STRATEGY_VERSION,
        input_snapshot: {
          dayAdjustment: {
            kind: DAY_ADJUSTMENT_SNAPSHOT_KIND,
            clientKey: "day-adjust:thu-to-fri",
            payloadHash: PAYLOAD_HASH,
            confirmedAt: "2026-11-19T10:56:00.000Z",
            timeZone: "Asia/Shanghai",
            sourceDate: "2026-11-19",
            targetDate: "2026-11-20",
            exceptionDraftId: EXC_ID,
            exceptionRevision: 1,
            budgetRevision: 1,
            sourceDay: {
              day: "2026-11-19",
              beforeVersion: 1,
              afterVersion: 2,
              beforeBlocks: [writingBlock, mathBefore],
              afterBlocks: [writingBlock],
              keptBlocks: [writingBlock],
              removedBlocks: [mathBefore],
              addedBlocks: [],
            },
            targetDay: {
              day: "2026-11-20",
              beforeVersion: 0,
              afterVersion: 1,
              beforeBlocks: [],
              afterBlocks: [mathFriday],
              addedBlocks: [mathFriday],
            },
            retestReschedules: [
              {
                retestId: RETEST_ID,
                taskId: MATH_ID,
                beforeVersion: 1,
                afterVersion: 2,
                beforeScheduledStartAt: mathBefore.start,
                afterScheduledStartAt: mathFriday.start,
              },
            ],
          },
        },
      },
    ],
    opening_plan_acceptances: [
      {
        workspace_id: WS,
        client_key: "day-adjust:thu-to-fri",
        draft_id: ADJ_ID,
        day: "2026-11-19",
        accepted_version: 2,
        payload_hash: PAYLOAD_HASH,
        source: "learner",
        before_blocks: [writingBlock, mathBefore],
        created_task_versions: {},
      },
    ],
  };
}

describe("validateBackupDayAdjustment", () => {
  it("passes untouched for legacy archives without day-exception/day-adjustment markers", () => {
    const errors: string[] = [];
    validateBackupDayAdjustment(
      {
        opening_plan_drafts: [
          {
            id: ADJ_ID,
            workspace_id: WS,
            owner_user_id: OWNER,
            day: "2026-11-19",
            strategy_version: "local-replan-v1",
            input_snapshot: {},
          },
        ],
      },
      errors,
    );
    expect(errors).toEqual([]);
  });

  it("accepts a complete Thu 15-min exception + atomic Fri reschedule + retest reschedule snapshot", () => {
    const errors: string[] = [];
    validateBackupDayAdjustment(validTables(), errors);
    expect(errors).toEqual([]);
  });

  it("rejects missing target day opening_plan_state", () => {
    const tables = validTables();
    tables.opening_plan_state = tables.opening_plan_state!.filter((row) => row.day !== "2026-11-20");
    const errors: string[] = [];
    validateBackupDayAdjustment(tables, errors);
    expect(errors.some((e) => e.includes("target day plan state"))).toBe(true);
  });

  it("rejects duplicate day exception revision on the same localDate", () => {
    const tables = validTables();
    const exc = structuredClone(tables.opening_plan_drafts![0]!);
    exc.id = "88888888-8888-4888-8888-888888888888";
    tables.opening_plan_drafts!.push(exc);
    const errors: string[] = [];
    validateBackupDayAdjustment(tables, errors);
    expect(errors.some((e) => e.includes("duplicate day exception revision"))).toBe(true);
  });

  it("rejects cross-owner tampered task references", () => {
    const tables = validTables();
    tables.opening_tasks![1]!.owner_user_id = OTHER_OWNER;
    const errors: string[] = [];
    validateBackupDayAdjustment(tables, errors);
    expect(errors.some((e) => e.includes("another user or workspace"))).toBe(true);
  });

  it("rejects stripped strategy_version or snapshot marker mismatch", () => {
    const tables = validTables();
    tables.opening_plan_drafts![1]!.strategy_version = null;
    const errors: string[] = [];
    validateBackupDayAdjustment(tables, errors);
    expect(errors.some((e) => e.includes("marker mismatch"))).toBe(true);
  });

  it("rejects tampered retest scheduled_start_at mismatch", () => {
    const tables = validTables();
    tables.opening_retest_activities![0]!.scheduled_start_at = "2026-11-20T12:00:00.000Z";
    const errors: string[] = [];
    validateBackupDayAdjustment(tables, errors);
    expect(errors.some((e) => e.includes("retest reschedule record is invalid"))).toBe(true);
  });

  it("rejects day exception whose effectiveAt does not fall on saved localDate in saved timeZone", () => {
    const tables = validTables();
    const snap = (tables.opening_plan_drafts![0]!.input_snapshot as { dayException: Record<string, unknown> }).dayException;
    // 2026-11-19T16:30:00Z is 2026-11-20 00:30 in Asia/Shanghai!
    snap.effectiveAt = "2026-11-19T16:30:00.000Z";
    const errors: string[] = [];
    validateBackupDayAdjustment(tables, errors);
    expect(errors.some((e) => e.includes("effectiveAt does not fall on its localDate"))).toBe(true);
  });
});

describe("day-exception capacity & continuous slot helpers", () => {
  it("computes max(0, min(D-B-Sday, remainingMinutes-Safter)) and shortfall accurately", () => {
    const result = evaluateDayExceptionCapacity({
      dailyMinutes: 90,
      bufferMinutes: 15,
      dayUsedMinutes: 65,
      exceptionRemainingMinutes: 15,
      afterLowerMinutes: 0,
      afterUpperMinutes: 0,
      requiredMinutes: 15,
    });
    // D - B - Sday = 10 < 15, so available = 10, shortfall = 5.
    expect(result.availableLowerMinutes).toBe(10);
    expect(result.availableUpperMinutes).toBe(10);
    expect(result.shortfallMinutes).toBe(5);
    expect(result.usageUncertain).toBe(false);
  });

  it("marks usageUncertain only when straddling bounds flip feasibility", () => {
    const bounds = straddlingUsageBounds({
      minutes: 20,
      startMs: Date.parse("2026-11-19T10:45:00.000Z"),
      endMs: Date.parse("2026-11-19T11:15:00.000Z"),
      effectiveAtMs: Date.parse("2026-11-19T11:00:00.000Z"),
    });
    expect(bounds).toEqual({ minAfter: 5, maxAfter: 15 });

    const uncertain = evaluateDayExceptionCapacity({
      dailyMinutes: 90,
      bufferMinutes: 15,
      dayUsedMinutes: 20,
      exceptionRemainingMinutes: 15,
      afterLowerMinutes: bounds.minAfter,
      afterUpperMinutes: bounds.maxAfter,
      requiredMinutes: 10,
    });
    expect(uncertain.usageUncertain).toBe(true);

    const definiteShortfall = evaluateDayExceptionCapacity({
      dailyMinutes: 90,
      bufferMinutes: 15,
      dayUsedMinutes: 20,
      exceptionRemainingMinutes: 15,
      afterLowerMinutes: bounds.minAfter,
      afterUpperMinutes: bounds.maxAfter,
      requiredMinutes: 15,
    });
    expect(definiteShortfall.usageUncertain).toBe(false);
    expect(definiteShortfall.shortfallMinutes).toBe(5);
  });

  it("never truncates an indivisible 25-minute task into a 15-minute free slot", () => {
    const slot = findContinuousFreeSlot({
      freeSlots: [
        {
          start: "2026-11-19T11:00:00.000Z",
          end: "2026-11-19T11:15:00.000Z",
          kind: "free",
        },
      ],
      durationMinutes: 25,
      earliestMs: Date.parse("2026-11-19T11:00:00.000Z"),
    });
    expect(slot).toBeNull();
  });
});
