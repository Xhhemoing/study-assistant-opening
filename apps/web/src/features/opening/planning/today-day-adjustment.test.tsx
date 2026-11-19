// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DayAdjustmentPreview } from "@aistudy/contracts";
import {
  DayAdjustmentRequestError,
  TodayDayAdjustment,
  type DayAdjustmentClient,
} from "./today-day-adjustment";

const DATE = "2026-11-19";
const TARGET_DATE = "2026-11-20";
const TIME_ZONE = "Asia/Shanghai";
const WRITING_ID = "55555555-5555-4555-8555-555555555555";
const MATH_ID = "66666666-6666-4666-8666-666666666666";
const EXC_ID = "33333333-3333-4333-8333-333333333333";
const ADJ_ID = "44444444-4444-4444-8444-444444444444";

const writingBlock = {
  taskId: WRITING_ID,
  start: "2026-11-19T11:00:00.000Z",
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
  start: "2026-11-20T11:15:00.000Z",
  end: "2026-11-20T11:40:00.000Z",
  reason: "planned",
};

function makePreview(overrides: Partial<DayAdjustmentPreview> = {}): DayAdjustmentPreview {
  return {
    status: "no_exception",
    sourceDate: DATE,
    targetDate: TARGET_DATE,
    timeZone: TIME_ZONE,
    now: "2026-11-19T10:55:00.000Z",
    dayException: null,
    exceptionRevision: 0,
    budgetRevision: 1,
    sourceAcceptedVersion: 1,
    targetAcceptedVersion: 0,
    sourceBeforeBlocks: [writingBlock, mathBefore],
    sourceAfterBlocks: [writingBlock, mathBefore],
    targetBeforeBlocks: [],
    targetAfterBlocks: [],
    keptBlocks: [writingBlock, mathBefore],
    removedBlocks: [],
    sourceAddedBlocks: [],
    targetAddedBlocks: [],
    sourceFreeSlots: [],
    targetFreeSlots: [
      {
        start: "2026-11-20T11:00:00.000Z",
        end: "2026-11-20T12:00:00.000Z",
        kind: "free",
      },
    ],
    capacityBefore: {
      dailyMinutes: 90,
      bufferMinutes: 15,
      dayUsedMinutes: 0,
      exceptionRemainingMinutes: null,
      afterLowerMinutes: 0,
      afterUpperMinutes: 0,
      availableLowerMinutes: 75,
      availableUpperMinutes: 75,
      requiredMinutes: 40,
      shortfallMinutes: 0,
      usageUncertain: false,
    },
    capacityAfter: {
      dailyMinutes: 90,
      bufferMinutes: 15,
      dayUsedMinutes: 0,
      exceptionRemainingMinutes: null,
      afterLowerMinutes: 0,
      afterUpperMinutes: 0,
      availableLowerMinutes: 75,
      availableUpperMinutes: 75,
      requiredMinutes: 40,
      shortfallMinutes: 0,
      usageUncertain: false,
    },
    targetCapacityAfter: null,
    taskRevisions: [
      { taskId: WRITING_ID, version: 1 },
      { taskId: MATH_ID, version: 1 },
    ],
    retestRevisions: [],
    tasks: [
      {
        taskId: WRITING_ID,
        title: "英语写作",
        minutes: 15,
        version: 1,
        isRetest: false,
        retestId: null,
        retestVersion: null,
        retestScheduledStartAt: null,
        dueAt: null,
        notBefore: null,
      },
      {
        taskId: MATH_ID,
        title: "高等数学",
        minutes: 25,
        version: 1,
        isRetest: false,
        retestId: null,
        retestVersion: null,
        retestScheduledStartAt: null,
        dueAt: null,
        notBefore: null,
      },
    ],
    quickCandidates: [],
    unplacedMoveTaskIds: [],
    blockers: [],
    canConfirm: false,
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function findButton(label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll("button")].find((btn) => btn.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match as HTMLButtonElement;
}

describe("TodayDayAdjustment", () => {
  it("declares 15 minutes, renders Thu/Fri diff, and confirms only on explicit click", async () => {
    const readyPreview = makePreview({
      status: "ready",
      dayException: {
        id: EXC_ID,
        localDate: DATE,
        timeZone: TIME_ZONE,
        effectiveAt: "2026-11-19T10:55:00.000Z",
        remainingMinutes: 15,
        expectedExceptionRevision: 0,
        revision: 1,
        replayed: false,
      },
      exceptionRevision: 1,
      sourceAfterBlocks: [writingBlock],
      keptBlocks: [writingBlock],
      removedBlocks: [mathBefore],
      targetAfterBlocks: [mathFriday],
      targetAddedBlocks: [mathFriday],
      capacityBefore: {
        dailyMinutes: 90,
        bufferMinutes: 15,
        dayUsedMinutes: 0,
        exceptionRemainingMinutes: 15,
        afterLowerMinutes: 0,
        afterUpperMinutes: 0,
        availableLowerMinutes: 15,
        availableUpperMinutes: 15,
        requiredMinutes: 40,
        shortfallMinutes: 25,
        usageUncertain: false,
      },
      capacityAfter: {
        dailyMinutes: 90,
        bufferMinutes: 15,
        dayUsedMinutes: 0,
        exceptionRemainingMinutes: 15,
        afterLowerMinutes: 0,
        afterUpperMinutes: 0,
        availableLowerMinutes: 15,
        availableUpperMinutes: 15,
        requiredMinutes: 15,
        shortfallMinutes: 0,
        usageUncertain: false,
      },
      canConfirm: true,
    });

    const afterConfirmPreview = makePreview({
      ...readyPreview,
      status: "no_change",
      sourceAcceptedVersion: 2,
      targetAcceptedVersion: 1,
      sourceBeforeBlocks: [writingBlock],
      sourceAfterBlocks: [writingBlock],
      keptBlocks: [writingBlock],
      removedBlocks: [],
      targetBeforeBlocks: [mathFriday],
      targetAfterBlocks: [mathFriday],
      targetAddedBlocks: [],
      canConfirm: false,
    });

    const onChanged = vi.fn();
    const client: DayAdjustmentClient = {
      getPreview: vi.fn(async () => makePreview()),
      declareToday: vi.fn(async () => ({
        action: "declare_today" as const,
        receipt: readyPreview.dayException!,
        preview: readyPreview,
      })),
      preview: vi.fn(async () => readyPreview),
      confirm: vi.fn(async () => ({
        action: "confirm" as const,
        receipt: {
          draftId: ADJ_ID,
          clientKey: "day-adjust:test",
          timeZone: TIME_ZONE,
          confirmedAt: "2026-11-19T10:56:00.000Z",
          exceptionDraftId: EXC_ID,
          exceptionRevision: 1,
          sourceDate: DATE,
          sourceBeforeVersion: 1,
          sourceAfterVersion: 2,
          sourceBlocks: [writingBlock],
          targetDate: TARGET_DATE,
          targetBeforeVersion: 0,
          targetAfterVersion: 1,
          targetBlocks: [mathFriday],
          retestReschedules: [],
          replayed: false,
        },
        preview: afterConfirmPreview,
      })),
    };

    await act(async () => {
      root.render(
        <TodayDayAdjustment
          date={DATE}
          timeZone={TIME_ZONE}
          client={client}
          onChanged={onChanged}
          defaultOpen
        />,
      );
    });

    expect(client.declareToday).not.toHaveBeenCalled();
    expect(client.confirm).not.toHaveBeenCalled();

    await act(async () => {
      findButton("今天只剩 15 分钟").click();
    });

    expect(client.declareToday).toHaveBeenCalledTimes(1);
    expect(client.confirm).not.toHaveBeenCalled();
    expect(host.textContent).toContain("英语写作");
    expect(host.textContent).toContain("高等数学");
    expect(host.textContent).toContain(TARGET_DATE);

    await act(async () => {
      findButton("确认这次调整").click();
    });

    expect(client.confirm).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("调整已确认");
  });

  it("shows usage_uncertain state while preserving declared minutes and disables confirm", async () => {
    const uncertainPreview = makePreview({
      status: "usage_uncertain",
      dayException: {
        id: EXC_ID,
        localDate: DATE,
        timeZone: TIME_ZONE,
        effectiveAt: "2026-11-19T10:55:00.000Z",
        remainingMinutes: 15,
        expectedExceptionRevision: 0,
        revision: 1,
        replayed: false,
      },
      exceptionRevision: 1,
      canConfirm: false,
    });
    const client: DayAdjustmentClient = {
      getPreview: vi.fn(async () => uncertainPreview),
      declareToday: vi.fn(),
      preview: vi.fn(async () => uncertainPreview),
      confirm: vi.fn(),
    };

    await act(async () => {
      root.render(
        <TodayDayAdjustment date={DATE} timeZone={TIME_ZONE} client={client} defaultOpen />,
      );
    });

    expect(host.querySelector('[data-testid="day-adjustment-uncertain"]')).toBeTruthy();
    expect(findButton("确认这次调整").disabled).toBe(true);
  });

  it("preserves same clientKey for retry after transient error and refreshes on 409 conflict", async () => {
    const readyPreview = makePreview({
      status: "ready",
      dayException: {
        id: EXC_ID,
        localDate: DATE,
        timeZone: TIME_ZONE,
        effectiveAt: "2026-11-19T10:55:00.000Z",
        remainingMinutes: 15,
        expectedExceptionRevision: 0,
        revision: 1,
        replayed: false,
      },
      exceptionRevision: 1,
      sourceAfterBlocks: [writingBlock],
      keptBlocks: [writingBlock],
      removedBlocks: [mathBefore],
      targetAfterBlocks: [mathFriday],
      targetAddedBlocks: [mathFriday],
      canConfirm: true,
    });

    const client: DayAdjustmentClient = {
      getPreview: vi.fn(async () => readyPreview),
      declareToday: vi.fn(),
      preview: vi.fn(async () => readyPreview),
      confirm: vi
        .fn()
        .mockRejectedValueOnce(new TypeError("network lost"))
        .mockRejectedValueOnce(new DayAdjustmentRequestError("计划已更新", 409, "CONFLICT", "stale_version")),
    };

    await act(async () => {
      root.render(
        <TodayDayAdjustment date={DATE} timeZone={TIME_ZONE} client={client} defaultOpen />,
      );
    });

    await act(async () => {
      findButton("确认这次调整").click();
    });
    const firstInput = vi.mocked(client.confirm).mock.calls[0]?.[0];
    expect(firstInput).toBeTruthy();

    await act(async () => {
      findButton("重试这次确认").click();
    });
    const secondInput = vi.mocked(client.confirm).mock.calls[1]?.[0];
    expect(secondInput?.clientKey).toBe(firstInput?.clientKey);
    // After 409 conflict, preview refreshes automatically.
    expect(client.getPreview).toHaveBeenCalledTimes(2);
  });
});
