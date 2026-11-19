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

  it("shows usage_uncertain state without claiming capacity fits and disables confirm", async () => {
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
      capacityBefore: {
        dailyMinutes: 90,
        bufferMinutes: 15,
        dayUsedMinutes: 20,
        exceptionRemainingMinutes: 15,
        afterLowerMinutes: 5,
        afterUpperMinutes: 15,
        availableLowerMinutes: 0,
        availableUpperMinutes: 10,
        requiredMinutes: 10,
        shortfallMinutes: 0,
        usageUncertain: true,
      },
      capacityAfter: {
        dailyMinutes: 90,
        bufferMinutes: 15,
        dayUsedMinutes: 20,
        exceptionRemainingMinutes: 15,
        afterLowerMinutes: 5,
        afterUpperMinutes: 15,
        availableLowerMinutes: 0,
        availableUpperMinutes: 10,
        requiredMinutes: 10,
        shortfallMinutes: 0,
        usageUncertain: true,
      },
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
    const capacityText = host.querySelector('[data-testid="day-adjustment-capacity"]')?.textContent ?? "";
    expect(capacityText).toContain("剩余时长待核对");
    expect(capacityText).not.toContain("可容纳");
    expect(findButton("确认这次调整").disabled).toBe(true);
  });

  it("disables main confirm while pending after transient error, preserves 409 error on refresh, and resets stale quick selection", async () => {
    const quickId = "88888888-8888-4888-8888-888888888888";
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
      quickCandidates: [
        {
          taskId: quickId,
          title: "短时背词",
          minutes: 10,
          version: 1,
          fits: true,
          shortfallMinutes: 0,
          reason: "可完整放入今日空档",
          suggestedSlot: {
            start: "2026-11-19T11:20:00.000Z",
            end: "2026-11-19T11:30:00.000Z",
            kind: "free",
          },
        },
      ],
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

    // Select a quick candidate first so we can verify 409 resets selectedQuickTaskId.
    await act(async () => {
      findButton("补入今日空档").click();
    });
    expect(findButton("取消补入")).toBeTruthy();

    await act(async () => {
      findButton("确认这次调整").click();
    });
    const firstInput = vi.mocked(client.confirm).mock.calls[0]?.[0];
    expect(firstInput).toBeTruthy();
    // Main confirm button MUST be disabled while pending retry is active so a new clientKey cannot be minted.
    expect(findButton("确认这次调整").disabled).toBe(true);
    await act(async () => {
      findButton("确认这次调整").click();
    });
    expect(client.confirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton("重试这次确认").click();
    });
    const secondInput = vi.mocked(client.confirm).mock.calls[1]?.[0];
    expect(secondInput?.clientKey).toBe(firstInput?.clientKey);
    // After 409 conflict, preview refreshes automatically, error message is preserved, and selection resets.
    expect(client.getPreview).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("计划已更新");
    expect(findButton("补入今日空档")).toBeTruthy();
  });

  it("keeps details panel expanded when user opens it and edits remaining minutes without active dayException", async () => {
    const client: DayAdjustmentClient = {
      getPreview: vi.fn(async () => makePreview()),
      declareToday: vi.fn(),
      preview: vi.fn(async () => makePreview()),
      confirm: vi.fn(),
    };

    await act(async () => {
      root.render(
        <TodayDayAdjustment date={DATE} timeZone={TIME_ZONE} client={client} defaultOpen={false} />,
      );
    });

    const details = host.querySelector('[data-testid="today-day-adjustment"]') as HTMLDetailsElement;
    expect(details.open).toBe(false);

    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(details.open).toBe(true);

    const input = host.querySelector('input[aria-label="今天剩余可用分钟"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "25");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("25");
    expect(details.open).toBe(true);
  });

  it("disables declare buttons and minutes input while pending retry is active and preserves 409 error when refresh fails", async () => {
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
      getPreview: vi
        .fn()
        .mockResolvedValueOnce(readyPreview)
        .mockRejectedValueOnce(new TypeError("refresh network down")),
      declareToday: vi
        .fn()
        .mockRejectedValueOnce(new TypeError("declare timeout"))
        .mockRejectedValueOnce(new DayAdjustmentRequestError("今日临时可用时长已更新", 409, "CONFLICT", "stale_version")),
      preview: vi.fn(async () => readyPreview),
      confirm: vi.fn(),
    };

    await act(async () => {
      root.render(
        <TodayDayAdjustment date={DATE} timeZone={TIME_ZONE} client={client} defaultOpen />,
      );
    });

    // Trigger transient error on declareToday -> pending retry active.
    await act(async () => {
      findButton("今天只剩 15 分钟").click();
    });
    expect(client.declareToday).toHaveBeenCalledTimes(1);
    expect(findButton("今天只剩 15 分钟").disabled).toBe(true);
    expect(findButton("今天只剩 30 分钟").disabled).toBe(true);
    expect(findButton("记录今天可用时长").disabled).toBe(true);
    const input = host.querySelector('input[aria-label="今天剩余可用分钟"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);

    // Retry returns 409, then auto-refresh fails -> original 409 message MUST be preserved.
    await act(async () => {
      findButton("重试这次确认").click();
    });
    expect(client.declareToday).toHaveBeenCalledTimes(2);
    expect(client.getPreview).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("今日临时可用时长已更新");
    expect(findButton("今天只剩 15 分钟").disabled).toBe(false);
  });

  it("handles null post-commit preview on declareToday by showing success notice and reloading preview", async () => {
    const initialPreview = makePreview();
    const reloadedPreview = makePreview({
      status: "no_change",
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
    });
    const client: DayAdjustmentClient = {
      getPreview: vi
        .fn()
        .mockResolvedValueOnce(initialPreview)
        .mockResolvedValueOnce(reloadedPreview),
      declareToday: vi.fn(async () => ({
        action: "declare_today" as const,
        receipt: reloadedPreview.dayException!,
        preview: null,
      })),
      preview: vi.fn(async () => reloadedPreview),
      confirm: vi.fn(),
    };

    await act(async () => {
      root.render(
        <TodayDayAdjustment date={DATE} timeZone={TIME_ZONE} client={client} defaultOpen />,
      );
    });

    await act(async () => {
      findButton("今天只剩 15 分钟").click();
    });

    expect(client.declareToday).toHaveBeenCalledTimes(1);
    expect(client.getPreview).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("已记录今天剩余 15 分钟");
  });
});
