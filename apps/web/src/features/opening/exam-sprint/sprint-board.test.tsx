// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PlanDraft, TaskItem } from "@aistudy/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpeningApi, TodayPlanRead } from "../client/api";
import { saveSprintCheckpoint, sprintAcceptance } from "./sprint-checkpoint";
import { SprintBoard } from "./sprint-board";
import { sprintCandidateBlocks, sprintPlanChanges, sprintTaskHref, sprintTodayTasks } from "./sprint-plan-model";

const course = "11111111-1111-4111-8111-111111111111", date = "2026-10-22";
const a = "22222222-2222-4222-8222-222222222222", b = "33333333-3333-4333-8333-333333333333", other = "44444444-4444-4444-8444-444444444444";
const draftId = "55555555-5555-4555-8555-555555555555", manualId = "66666666-6666-4666-8666-666666666666";
const block = (taskId: string, hour: number) => ({ taskId, start: `${date}T${hour}:00:00Z`, end: `${date}T${hour}:20:00Z`, reason: "继续本课" });
const tasks: TaskItem[] = [
  { id: a, title: "现有任务", minutes: 20, dueAt: null, priority: 1, status: "pending", courseId: course },
  { id: b, title: "候选任务", minutes: 20, dueAt: null, priority: 1, status: "pending", courseId: course },
  { id: other, title: "另一门课的任务", minutes: 20, dueAt: null, priority: 1, status: "pending", courseId: "other" },
];
const draft: PlanDraft = { id: draftId, date, status: "draft", version: 1, baseVersion: 1, blocks: [block(b, 13), block(other, 14)], unscheduledTaskIds: [] };
const current: TodayPlanRead = { date, acceptedVersion: 1, blocks: [block(a, 12), block(other, 14)], hardBlocks: [], dailyDraft: draft };
function client() {
  return {
    getPlanningSettings: vi.fn().mockResolvedValue({ settings: { timeZone: "Asia/Shanghai" }, invalidStoredSettings: false }),
    getAdaptivePrefs: vi.fn().mockResolvedValue({ prefs: { courseGoals: { [course]: { targetDate: "2026-11-02", weeklyMinutes: 120 } } }, invalidStoredPrefs: false }),
    getToday: vi.fn().mockResolvedValue(current), listTasks: vi.fn().mockResolvedValue({ tasks }),
    proposePlan: vi.fn().mockResolvedValue({ ...draft, id: manualId }),
    acceptPlan: vi.fn().mockResolvedValue({ ...draft, status: "accepted", version: 2 }), rejectPlan: vi.fn(),
  };
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.sessionStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(`${date}T08:00:00Z`));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(item => item.textContent === label);
  expect(found, label).toBeTruthy(); return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function render(api: ReturnType<typeof client>) {
  await act(async () => root.render(createElement(SprintBoard, { courseId: course, courseTitle: "线性代数", api: api as unknown as OpeningApi })));
}
async function preview() {
  await click("调整安排");
  await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
}

describe("sprint plan confirmation", () => {
  it("starts with the current course plan and keeps adjustments collapsed", async () => {
    const api = client(); await render(api);
    expect(button("调整安排").getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('input[type="radio"]')).toBeNull();
    expect(host.textContent).toContain("现有任务");
    expect(host.textContent).not.toContain("候选任务");
    expect(host.textContent).not.toContain("另一门课的任务");
    expect(host.querySelector(`a[href="/opening/courses/${course}/study?task=${a}"]`)?.textContent).toBe("开始：现有任务");
    expect(api.proposePlan).not.toHaveBeenCalled(); expect(api.acceptPlan).not.toHaveBeenCalled();
  });
  it("previews and cancels without changing the current plan or writing acceptance", async () => {
    const api = client(); await render(api); await preview();
    expect(host.textContent).toContain("变化预览，尚未生效");
    expect(host.textContent).toContain("新增：候选任务");
    expect(host.textContent).toContain("移出今天：现有任务");
    expect(host.querySelector(`a[href*="task=${a}"]`)).not.toBeNull();
    await click("取消预览");
    expect(host.textContent).not.toContain("变化预览，尚未生效");
    expect(api.acceptPlan).not.toHaveBeenCalled(); expect(api.rejectPlan).not.toHaveBeenCalled();
  });
  it("prevents repeated apply, switching candidates and cancellation while applying", async () => {
    const api = client(); let resolve!: (value: PlanDraft) => void;
    api.acceptPlan.mockReturnValue(new Promise(done => { resolve = done; }));
    await render(api); await preview();
    await act(async () => { button("确认应用这个安排").click(); button("确认应用这个安排").click(); });
    expect(api.acceptPlan).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
    expect(button("取消预览").disabled).toBe(true);
    expect(button("收起调整").disabled).toBe(true);
    expect(button("正在处理…").disabled).toBe(true);
    api.getToday.mockResolvedValue({ ...current, acceptedVersion: 2, blocks: draft.blocks, dailyDraft: null });
    await act(async () => { resolve({ ...draft, status: "accepted", version: 2 }); });
    expect(host.textContent).toContain("安排已应用。");
    expect(host.querySelector(`a[href="/opening/courses/${course}/study?task=${b}"]`)?.textContent).toBe("开始：候选任务");
    expect(host.querySelector(`a[href*="task=${a}"]`)).toBeNull();
    expect(api.getToday).toHaveBeenCalledTimes(2);
  });
  it("keeps current tasks and the preview after failure and retries the same acceptance identity", async () => {
    const api = client(); api.acceptPlan.mockRejectedValue(new Error("网络中断"));
    await render(api); await preview(); await click("确认应用这个安排");
    expect(host.textContent).toContain("网络中断");
    expect(host.textContent).toContain("应用结果待核对");
    expect(host.querySelector(`a[href*="task=${a}"]`)).not.toBeNull();
    await click("核对并重试原应用");
    expect(api.acceptPlan.mock.calls[1]![0]).toEqual(api.acceptPlan.mock.calls[0]![0]);
    expect(api.getToday).toHaveBeenCalledTimes(1);
  });
  it("distinguishes applied-but-refresh-failed from an unapplied preview", async () => {
    const api = client(); await render(api); await preview();
    api.getToday.mockRejectedValue(new Error("读取失败"));
    await click("确认应用这个安排");
    expect(host.textContent).toContain("安排已应用，任务暂未刷新");
    expect(host.textContent).not.toContain("尚未生效");
    expect(host.querySelector(`a[href*="task=${a}"]`)).toBeNull();
    expect(api.acceptPlan).toHaveBeenCalledTimes(1);
  });
});

describe("sprint refresh and re-entry", () => {
  it.each(["propose", "apply"] as const)("refreshes the workspace date before a new %s after midnight", async action => {
    const api = client(); await render(api);
    if (action === "apply") await preview(); else await click("调整安排");
    // Midnight in the workspace, while UTC still has the previous date.
    vi.setSystemTime(new Date(`${date}T16:00:01Z`));
    api.getToday.mockResolvedValue({ ...current, date: "2026-10-23", blocks: [], dailyDraft: null });
    await click(action === "apply" ? "确认应用这个安排" : "重新生成候选");
    expect(api.getToday).toHaveBeenLastCalledWith("2026-10-23");
    expect(api.proposePlan).not.toHaveBeenCalled();
    expect(api.acceptPlan).not.toHaveBeenCalled();
    expect(host.textContent).toContain("日期已改变");
    expect(host.querySelector(`a[href*="task=${a}"]`)).toBeNull();
  });
  async function reenter(api: ReturnType<typeof client>) {
    await act(async () => root.render(null));
    await render(api);
  }
  async function manual(api: ReturnType<typeof client>) {
    api.getToday.mockResolvedValue({ ...current, dailyDraft: null });
    await render(api); await click("调整安排"); await click("生成候选安排");
  }
  it("restores a manual candidate after refresh and re-entry without proposing or applying again", async () => {
    const api = client(); await manual(api);
    expect(host.textContent).toContain("变化预览，尚未生效");
    await click("刷新计划");
    expect(host.textContent).toContain("变化预览，尚未生效");
    await reenter(api);
    expect(button("调整安排").getAttribute("aria-expanded")).toBe("false");
    await click("调整安排");
    expect(host.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    expect(host.textContent).toContain("新增：候选任务");
    expect(api.proposePlan).toHaveBeenCalledTimes(1); expect(api.acceptPlan).not.toHaveBeenCalled();
    expect(api.getToday).toHaveBeenCalledTimes(3);
  });
  it("reads current server tasks before explicitly replaying a lost acceptance with the original input", async () => {
    const api = client(); api.acceptPlan.mockRejectedValueOnce(new Error("response lost"));
    await manual(api); await click("确认应用这个安排");
    const original = api.acceptPlan.mock.calls[0]![0];
    api.getToday.mockResolvedValue({ ...current, dailyDraft: null, acceptedVersion: 2, blocks: draft.blocks });
    await reenter(api);
    expect(api.acceptPlan).toHaveBeenCalledTimes(1);
    expect(host.querySelector(`a[href*="task=${b}"]`)).not.toBeNull();
    expect(host.textContent).not.toContain("安排已应用。");
    expect(host.textContent).toContain("结果尚未确认");
    api.acceptPlan.mockResolvedValue({ ...draft, id: manualId, status: "accepted", version: 2 });
    await click("核对并重试原应用");
    expect(api.acceptPlan.mock.calls[1]![0]).toEqual(original);
    expect(host.textContent).toContain("安排已应用。");
    expect(window.sessionStorage.getItem(`study:sprint:v1:${course}`)).toBeNull();
  });
  it("rejoins a still-running application after route re-entry instead of issuing another HTTP write", async () => {
    const api = client(); let resolve!: (value: PlanDraft) => void;
    api.acceptPlan.mockReturnValue(new Promise(done => { resolve = done; }));
    await manual(api); await click("确认应用这个安排"); await reenter(api);
    expect(api.getToday).toHaveBeenCalledTimes(2); expect(api.acceptPlan).toHaveBeenCalledTimes(1);
    await click("核对并重试原应用");
    expect(api.acceptPlan).toHaveBeenCalledTimes(1);
    api.getToday.mockResolvedValue({ ...current, dailyDraft: null, acceptedVersion: 2, blocks: draft.blocks });
    await act(async () => resolve({ ...draft, id: manualId, status: "accepted", version: 2 }));
    expect(host.textContent).toContain("安排已应用。");
  });
  it("keeps an unknown request when the server cannot be read and does not render it as today's plan", async () => {
    const api = client(); api.acceptPlan.mockRejectedValueOnce(new Error("response lost"));
    await manual(api); await click("确认应用这个安排");
    api.getToday.mockRejectedValue(new Error("offline"));
    await reenter(api);
    expect(api.acceptPlan).toHaveBeenCalledTimes(1);
    expect(host.querySelector(`a[href*="task=${a}"]`)).toBeNull();
    expect(host.querySelector(`a[href*="task=${b}"]`)).toBeNull();
    expect(host.textContent).not.toContain("核对并重试原应用");
    expect(window.sessionStorage.getItem(`study:sprint:v1:${course}`)).not.toBeNull();
  });
  it("does not apply an old-date or tampered recovery record and waits for an explicit discard", async () => {
    const api = client();
    const saved = { version: 1 as const, courseId: course, date: "2026-10-21", draft: { ...draft, date: "2026-10-21" }, acceptInput: sprintAcceptance(draft) };
    window.sessionStorage.setItem(`study:sprint:v1:${course}`, JSON.stringify(saved));
    await render(api);
    expect(host.textContent).toContain("另一日期或课程");
    await click("调整安排");
    expect(button("重新生成候选").disabled).toBe(true);
    expect(api.acceptPlan).not.toHaveBeenCalled(); expect(api.proposePlan).not.toHaveBeenCalled();
    await click("清除恢复记录");
    expect(button("重新生成候选").disabled).toBe(false);
    window.sessionStorage.setItem(`study:sprint:v1:${course}`, JSON.stringify({ ...saved, date, applied: true }));
    await click("刷新计划");
    expect(host.textContent).toContain("恢复记录不完整");
    expect(api.acceptPlan).not.toHaveBeenCalled();
  });
  it("blocks a stale restored preview but retains an exact pending request for server-side receipt recovery", async () => {
    const api = client();
    saveSprintCheckpoint({ version: 1, courseId: course, date, draft, acceptInput: null });
    api.getToday.mockResolvedValue({ ...current, dailyDraft: null, acceptedVersion: 2 });
    await render(api); await click("调整安排");
    expect(button("确认应用这个安排").disabled).toBe(true);
    expect(host.textContent).toContain("当前计划已变化");
    expect(api.acceptPlan).not.toHaveBeenCalled();
  });
  it("does not carry one course's recovery or in-flight state into a different course", async () => {
    const api = client();
    saveSprintCheckpoint({ version: 1, courseId: course, date, draft, acceptInput: sprintAcceptance(draft) });
    await render(api);
    expect(host.textContent).toContain("核对并重试原应用");
    const nextCourse = "77777777-7777-4777-8777-777777777777";
    await act(async () => root.render(createElement(SprintBoard, { courseId: nextCourse, courseTitle: "另一课程", api: api as unknown as OpeningApi })));
    expect(host.textContent).not.toContain("核对并重试原应用");
    expect(host.querySelector(`a[href*="task=${a}"]`)).toBeNull();
    expect(host.querySelector(`a[href*="task=${b}"]`)).toBeNull();
    expect(window.sessionStorage.getItem(`study:sprint:v1:${course}`)).not.toBeNull();
    expect(api.acceptPlan).not.toHaveBeenCalled();
  });
  it("does not send if the acceptance identity cannot be persisted", async () => {
    const api = client(); await render(api); await preview();
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    try {
      await click("确认应用这个安排");
      expect(host.textContent).toContain("尚未发送应用请求");
      expect(api.acceptPlan).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
});

describe("sprint service-result presentation", () => {
  it("does not offer completed, future retest or deferred tasks as the next action", () => {
    const future = "2099-10-22T00:00:00Z";
    const rows = sprintTodayTasks([{ ...tasks[0]!, status: "done" }, { ...tasks[1]!, notBefore: future }], [block(a, 12), block(b, 13)], course);
    expect(rows.map(row => row.actionable)).toEqual([false, false]);
    expect(sprintTaskHref({ ...tasks[0]!, suggestionKind: "review_cards" })).toBe("/opening/review?tab=cards");
  });
  it("shows a timing change when one of a task's split slots is removed", () => {
    const candidate = { ...draft, blocks: [block(a, 12)] };
    expect(sprintPlanChanges([block(a, 12), block(a, 13)], candidate, tasks)).toMatchObject([{ kind: "调整时间", title: "现有任务" }]);
  });
  it("does not preview rejected or unscheduled suggestions as additions that will be applied", () => {
    const candidate: PlanDraft = { ...draft, blocks: [block(b, 13)], suggestedTasks: [{ id: b, key: "suggestion-b", title: "新建议", minutes: 20, kind: "weak_skill", courseId: course, skillLabel: "向量", reasonCode: "weak_skill", reason: "巩固" }], rejectedSuggestedKeys: ["suggestion-b"] };
    expect(sprintCandidateBlocks(candidate)).toEqual([]);
    expect(sprintPlanChanges([], candidate, tasks)).toEqual([]);
  });
});
