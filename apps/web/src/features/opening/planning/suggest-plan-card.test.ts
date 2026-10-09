import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanDraft, PlannedBlock } from "@aistudy/contracts";
import {
  buildSuggestProposeBody,
  createSuggestPlanControllers,
  diffAgainstConfirmedPlan,
  SuggestPlanCard,
  SUGGEST_PRESET_LABELS,
} from "./suggest-plan-card";

const draftId = "11111111-1111-4111-8111-111111111111";
const taskA = "22222222-2222-4222-8222-222222222222";
const taskB = "33333333-3333-4333-8333-333333333333";

function draft(partial: Partial<PlanDraft> & Pick<PlanDraft, "blocks" | "unscheduledTaskIds">): PlanDraft {
  return {
    id: draftId,
    date: "2026-10-09",
    version: 1,
    baseVersion: 0,
    status: "draft",
    ...partial,
  };
}

describe("buildSuggestProposeBody", () => {
  it("omits free for timetable preset so the server can derive", () => {
    expect(buildSuggestProposeBody("timetable", "2026-10-09", "suggest-key-01")).toEqual({
      date: "2026-10-09",
      clientKey: "suggest-key-01",
    });
  });

  it("passes tonight and one-hour free windows", () => {
    const tonight = buildSuggestProposeBody("tonight", "2026-10-09", "suggest-key-02");
    expect(tonight.free).toHaveLength(1);
    expect(tonight.free![0]!.kind).toBe("free");
    expect(new Date(tonight.free![0]!.start).getHours()).toBe(19);
    expect(new Date(tonight.free![0]!.end).getHours()).toBe(22);

    const hour = buildSuggestProposeBody("one_hour", "2026-10-09", "suggest-key-03");
    const minutes = (Date.parse(hour.free![0]!.end) - Date.parse(hour.free![0]!.start)) / 60_000;
    expect(minutes).toBe(60);
  });
});

describe("diffAgainstConfirmedPlan", () => {
  it("classifies added, moved, removed, and unscheduled", () => {
    const confirmed: PlannedBlock[] = [
      {
        taskId: taskA,
        start: "2026-10-09T11:00:00.000Z",
        end: "2026-10-09T11:25:00.000Z",
        reason: "due",
      },
      {
        taskId: taskB,
        start: "2026-10-09T12:00:00.000Z",
        end: "2026-10-09T12:25:00.000Z",
        reason: "due",
      },
    ];
    const next = draft({
      blocks: [
        {
          taskId: taskA,
          start: "2026-10-09T13:00:00.000Z",
          end: "2026-10-09T13:25:00.000Z",
          reason: "due",
        },
        {
          taskId: "44444444-4444-4444-8444-444444444444",
          start: "2026-10-09T14:00:00.000Z",
          end: "2026-10-09T14:25:00.000Z",
          reason: "priority",
        },
      ],
      unscheduledTaskIds: [taskB],
    });
    const diff = diffAgainstConfirmedPlan(confirmed, next);
    expect(diff.moved.map((block) => block.taskId)).toEqual([taskA]);
    expect(diff.added.map((block) => block.taskId)).toEqual(["44444444-4444-4444-8444-444444444444"]);
    expect(diff.removed.map((block) => block.taskId)).toEqual([taskB]);
    expect(diff.unscheduledTaskIds).toEqual([taskB]);
  });
});

describe("createSuggestPlanControllers", () => {
  it("propose does not call accept — confirmed plan stays unchanged until confirm", async () => {
    const proposed = draft({
      blocks: [{
        taskId: taskA,
        start: "2026-10-09T11:00:00.000Z",
        end: "2026-10-09T11:25:00.000Z",
        reason: "due",
      }],
      unscheduledTaskIds: [],
    });
    const proposePlan = vi.fn(async () => proposed);
    const acceptPlan = vi.fn(async () => ({ ...proposed, status: "accepted" as const }));
    const rejectPlan = vi.fn(async () => ({ ...proposed, status: "rejected" as const }));
    const controllers = createSuggestPlanControllers(
      { proposePlan, acceptPlan, rejectPlan },
      { date: "2026-10-09", mintClientKey: () => "suggest-fixed-key" },
    );

    const result = await controllers.propose("timetable");
    expect(result).toEqual(proposed);
    expect(proposePlan).toHaveBeenCalledTimes(1);
    expect(proposePlan.mock.calls[0]![0]).toEqual({
      date: "2026-10-09",
      clientKey: "suggest-fixed-key",
    });
    expect(acceptPlan).not.toHaveBeenCalled();

    await controllers.accept(result);
    expect(acceptPlan).toHaveBeenCalledTimes(1);
    expect(acceptPlan.mock.calls[0]![0]).toMatchObject({
      draftId: draftId,
      expectedBaseVersion: 0,
    });
  });
});

describe("SuggestPlanCard", () => {
  it("renders presets and never auto-accepts on mount", () => {
    const proposePlan = vi.fn();
    const acceptPlan = vi.fn();
    const rejectPlan = vi.fn();
    const html = renderToStaticMarkup(createElement(SuggestPlanCard, {
      api: { proposePlan, acceptPlan, rejectPlan },
      date: "2026-10-09",
    }));
    expect(html).toContain("按建议安排");
    expect(html).toContain(SUGGEST_PRESET_LABELS.timetable);
    expect(html).toContain(SUGGEST_PRESET_LABELS.tonight);
    expect(html).toContain(SUGGEST_PRESET_LABELS.one_hour);
    expect(html).toContain("确认后才改变正式计划");
    expect(proposePlan).not.toHaveBeenCalled();
    expect(acceptPlan).not.toHaveBeenCalled();
  });
});
