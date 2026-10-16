import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanDraft } from "@aistudy/contracts";
import {
  createDailyDraftControllers,
  DailyDraftCard,
  dailyDraftSkippedCopy,
  reduceDailyDraftCard,
} from "./daily-draft-card";

const draftId = "11111111-1111-4111-8111-111111111111";
const taskA = "22222222-2222-4222-8222-222222222222";

function draftApi(partial: {
  proposePlan?: ReturnType<typeof vi.fn>;
  acceptPlan?: ReturnType<typeof vi.fn>;
  rejectPlan?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    proposePlan: partial.proposePlan ?? vi.fn(),
    acceptPlan: partial.acceptPlan ?? vi.fn(),
    rejectPlan: partial.rejectPlan ?? vi.fn(),
    getPlanningSettings: vi.fn(),
    putPlanningSettings: vi.fn(),
    createTask: vi.fn(),
  };
}

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

const sampleDraft = draft({
  blocks: [{
    taskId: taskA,
    start: "2026-10-09T11:00:00.000Z",
    end: "2026-10-09T11:25:00.000Z",
    reason: "顺延自昨天",
  }],
  unscheduledTaskIds: [],
});

const suggestedDraft: PlanDraft = {
  ...sampleDraft,
  blocks: [...sampleDraft.blocks, { ...sampleDraft.blocks[0]!, taskId: "suggestion-b" }],
  suggestedTasks: ["a", "b", "blocked"].map((key) => ({
    key: `planner:2026-10-09:${key}`, id: key === "a" ? taskA : `suggestion-${key}`,
    kind: "weak_skill", title: `巩固 ${key}`, minutes: 25, courseId: null,
    skillLabel: key, reasonCode: "weak_skill", reason: "近期需要巩固",
  })),
  unscheduledTaskIds: ["suggestion-blocked"],
};
const keyA = suggestedDraft.suggestedTasks![0]!.key;
const keyB = suggestedDraft.suggestedTasks![1]!.key;

describe("dailyDraftSkippedCopy", () => {
  it("shows unplanned count when plan already accepted", () => {
    expect(dailyDraftSkippedCopy("accepted", 3)).toBe("有 3 项新任务未排入");
    expect(dailyDraftSkippedCopy("accepted")).toBe("有 0 项新任务未排入");
  });

  it("explains rejected and no_settings without inventing a draft", () => {
    expect(dailyDraftSkippedCopy("rejected")).toContain("已拒绝");
    expect(dailyDraftSkippedCopy("no_settings")).toContain("学期设置");
  });
});

describe("createDailyDraftControllers", () => {
  it("confirm / reject / adjust call existing accept, reject, and re-propose", async () => {
    const proposed = draft({
      id: "44444444-4444-4444-8444-444444444444",
      blocks: sampleDraft.blocks,
      unscheduledTaskIds: [],
    });
    const proposePlan = vi.fn(async () => proposed);
    const acceptPlan = vi.fn(async () => ({ ...sampleDraft, status: "accepted" as const }));
    const rejectPlan = vi.fn(async () => ({ ...sampleDraft, status: "rejected" as const }));
    const controllers = createDailyDraftControllers(
      { proposePlan, acceptPlan, rejectPlan },
      { date: "2026-10-09", mintClientKey: () => "daily-draft-fixed-key" },
    );

    await controllers.accept(sampleDraft);
    expect(acceptPlan).toHaveBeenCalledTimes(1);
    expect(acceptPlan.mock.calls[0]![0]).toMatchObject({
      draftId,
      expectedBaseVersion: 0,
      clientKey: "daily-draft-fixed-key",
      acceptSuggestedKeys: [],
    });
    expect(proposePlan).not.toHaveBeenCalled();

    await controllers.reject(draftId);
    expect(rejectPlan).toHaveBeenCalledWith(draftId);

    const adjusted = await controllers.adjust();
    expect(proposePlan).toHaveBeenCalledTimes(1);
    expect(proposePlan.mock.calls[0]![0]).toEqual({
      date: "2026-10-09",
      clientKey: "daily-draft-fixed-key",
    });
    expect(adjusted).toEqual(proposed);
    // Adjust never auto-accepts.
    expect(acceptPlan).toHaveBeenCalledTimes(1);
  });

  it("sends only the normalized selected keys and keeps retries on the same intent key", async () => {
    const acceptPlan = vi.fn().mockRejectedValueOnce(new Error("network lost")).mockResolvedValue(suggestedDraft);
    let sequence = 0;
    const controllers = createDailyDraftControllers(draftApi({ acceptPlan }), { date: sampleDraft.date, mintClientKey: () => `intent-key-${++sequence}` });
    await expect(controllers.accept(suggestedDraft, [keyB, keyA, keyB, "unknown", suggestedDraft.suggestedTasks![2]!.key])).rejects.toThrow("network lost");
    await controllers.accept(suggestedDraft, [keyA, keyB]);
    expect(acceptPlan.mock.calls[0]![0]).toEqual(acceptPlan.mock.calls[1]![0]);
    expect(acceptPlan.mock.calls[1]![0].acceptSuggestedKeys).toEqual([keyA, keyB]);

    await controllers.accept(suggestedDraft, [keyA]);
    expect(acceptPlan.mock.calls[2]![0].clientKey).not.toBe(acceptPlan.mock.calls[1]![0].clientKey);
    await controllers.accept(suggestedDraft, []);
    expect(acceptPlan.mock.calls[3]![0].acceptSuggestedKeys).toEqual([]);
    await controllers.accept(suggestedDraft, [keyB, keyA]);
    expect(acceptPlan.mock.calls[4]![0].clientKey).toBe(acceptPlan.mock.calls[0]![0].clientKey);
    await controllers.accept({ ...suggestedDraft, baseVersion: 1 }, [keyA, keyB]);
    expect(acceptPlan.mock.calls[5]![0].clientKey).not.toBe(acceptPlan.mock.calls[0]![0].clientKey);
  });

  it("coalesces two confirmations before the first response arrives", async () => {
    let resolve!: (value: PlanDraft) => void;
    const acceptPlan = vi.fn(() => new Promise<PlanDraft>((done) => { resolve = done; }));
    const controllers = createDailyDraftControllers(draftApi({ acceptPlan }), { date: sampleDraft.date });
    const first = controllers.accept(suggestedDraft, [keyA, keyB]);
    const second = controllers.accept(suggestedDraft, [keyB, keyA]);
    expect(acceptPlan).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    resolve(suggestedDraft);
    await first;
  });
});

describe("reduceDailyDraftCard", () => {
  it("keeps the draft on failure — no optimistic clear", () => {
    const state = { draft: sampleDraft, error: "" };
    const next = reduceDailyDraftCard(state, {
      type: "action_fail",
      message: "网络错误",
    });
    expect(next.draft).toEqual(sampleDraft);
    expect(next.error).toBe("网络错误");
  });

  it("clears draft only after successful accept or reject", () => {
    const state = { draft: sampleDraft, error: "旧错误" };
    expect(reduceDailyDraftCard(state, { type: "accept_ok" })).toEqual({ draft: null, error: "" });
    expect(reduceDailyDraftCard(state, { type: "reject_ok" })).toEqual({ draft: null, error: "" });
  });

  it("replaces draft after successful adjust without accepting", () => {
    const nextDraft = draft({
      id: "55555555-5555-4555-8555-555555555555",
      blocks: sampleDraft.blocks,
      unscheduledTaskIds: [taskA],
    });
    const next = reduceDailyDraftCard(
      { draft: sampleDraft, error: "" },
      { type: "adjust_ok", draft: nextDraft },
    );
    expect(next.draft).toEqual(nextDraft);
    expect(next.error).toBe("");
  });

  it("keeps the exact selection on failure and preserves deselections across a refreshed draft", () => {
    const selected = reduceDailyDraftCard({ draft: suggestedDraft, error: "" }, { type: "select", keys: [keyA] });
    const failed = reduceDailyDraftCard(selected, { type: "action_fail", message: "请重新读取" });
    expect(failed.selectedSuggestedKeys).toEqual([keyA]);
    const refreshed = reduceDailyDraftCard(failed, { type: "hydrate", draft: { ...suggestedDraft, id: "replacement-draft" } });
    expect(refreshed.selectedSuggestedKeys).toEqual([keyA]);
    expect(refreshed.draft?.id).toBe("replacement-draft");
  });
});

describe("DailyDraftCard", () => {
  it("keeps adaptive controls hidden when the capability is off", () => {
    const html = renderToStaticMarkup(createElement(DailyDraftCard, {
      api: draftApi(), date: sampleDraft.date, dailyDraft: sampleDraft,
      adaptivePlanning: false, hasNewerSuggestion: true, onRefreshSuggestions: vi.fn(),
    }));
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("安排与依据");
    expect(html).not.toContain("有新建议");
    expect(html).not.toContain("副驾驶");
  });

  it("shows only the next selected activity and its reason before expansion", () => {
    const html = renderToStaticMarkup(createElement(DailyDraftCard, {
      api: draftApi(), date: sampleDraft.date, dailyDraft: { ...suggestedDraft, strategyVersion: "adaptive-test" }, adaptivePlanning: true,
    }));
    expect(html).toContain("下一项：巩固 a");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("巩固 b");
    expect(html).not.toContain("adaptive-test");
  });
  it("never auto-accepts on mount and shows carry-over reason from draft", () => {
    const proposePlan = vi.fn();
    const acceptPlan = vi.fn();
    const rejectPlan = vi.fn();
    const html = renderToStaticMarkup(createElement(DailyDraftCard, {
      api: draftApi({ proposePlan, acceptPlan, rejectPlan }),
      date: "2026-10-09",
      dailyDraft: sampleDraft,
      tasks: [{
        id: taskA,
        title: "昨日未完成",
        status: "pending" as const,
        minutes: 25,
        dueAt: null,
        priority: 1,
      }],
    }));
    expect(html).toContain("今日推荐草案");
    expect(html).toContain("顺延自昨天");
    expect(html).toContain("确认");
    expect(html).toContain("调整");
    expect(html).toContain("拒绝");
    expect(proposePlan).not.toHaveBeenCalled();
    expect(acceptPlan).not.toHaveBeenCalled();
    expect(rejectPlan).not.toHaveBeenCalled();
  });

  it("shows skipped copy when plan already accepted", () => {
    const html = renderToStaticMarkup(createElement(DailyDraftCard, {
      api: draftApi(),
      date: "2026-10-09",
      dailyDraftSkippedReason: "accepted",
      unplannedPendingCount: 2,
    }));
    expect(html).toContain("有 2 项新任务未排入");
    expect(html).not.toContain("确认");
  });

  it("shows rejected and no_settings copy without inventing a draft", () => {
    const rejected = renderToStaticMarkup(createElement(DailyDraftCard, {
      api: draftApi(),
      date: "2026-10-09",
      dailyDraftSkippedReason: "rejected",
    }));
    expect(rejected).toContain("已拒绝");
    expect(rejected).not.toContain("确认");
    expect(rejected).not.toContain("用默认作息生成本日计划");

    const noSettings = renderToStaticMarkup(createElement(DailyDraftCard, {
      api: draftApi(),
      date: "2026-10-09",
      dailyDraftSkippedReason: "no_settings",
    }));
    expect(noSettings).toContain("学期设置");
    expect(noSettings).toContain("用默认作息生成本日计划");
  });
});
