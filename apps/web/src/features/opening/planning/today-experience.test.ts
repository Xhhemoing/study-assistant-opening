import { describe, expect, it, vi } from "vitest";
import type { TaskItem } from "@aistudy/contracts";
import { selectTodayTask } from "./today-task-selection";
import { planProposalIntent } from "./plan-input";
import { readTodayData } from "./today-data-loader";

function task(id: string, status: TaskItem["status"] = "pending"): TaskItem {
  return { id, title: id, status, minutes: 20, priority: 1, dueAt: null };
}
const emptyGroups = () => ({ confirmed: [], dueRetests: [], overdue: [], other: [], done: [] } as {
  confirmed: TaskItem[]; dueRetests: TaskItem[]; overdue: TaskItem[]; other: TaskItem[]; done: TaskItem[];
});

describe("today selection follows the visible learning queue", () => {
  it("does not open a future retest hidden by the queue, even via a stale selection or deep link", () => {
    const groups = { ...emptyGroups(), other: [task("available")] };
    expect(selectTodayTask(groups, { selectedId: "future", focusTaskId: "future" })?.id).toBe("available");
  });
  it("does not invent a task when only future retests or no tasks remain", () => {
    expect(selectTodayTask(emptyGroups(), { selectedId: "future" })).toBeNull();
  });
  it("prioritizes the same confirmed, due, overdue, other groups displayed by the UI", () => {
    const groups = { confirmed: [task("plan")], dueRetests: [task("retest")], overdue: [task("late")], other: [task("other")], done: [] };
    expect(selectTodayTask(groups)?.id).toBe("plan");
    expect(selectTodayTask({ ...groups, confirmed: [] })?.id).toBe("retest");
    expect(selectTodayTask({ ...groups, confirmed: [], dueRetests: [] })?.id).toBe("late");
  });
  it("preserves the user's current eligible task when plan metadata arrives", () => {
    expect(selectTodayTask({ ...emptyGroups(), confirmed: [task("plan")], other: [task("mine")] }, { selectedId: "mine" })?.id).toBe("mine");
  });
  it.each(["done", "skipped"] as const)("advances an ordinary %s task without changing stored status", status => {
    const finished = task("finished", status);
    expect(selectTodayTask({ ...emptyGroups(), other: [task("next")], done: [finished] }, { selectedId: "finished" })?.id).toBe("next");
    expect(finished.status).toBe(status);
  });
  it("keeps explicit completed-task deep links readable", () => {
    expect(selectTodayTask({ ...emptyGroups(), other: [task("next")], done: [task("history", "done")] }, { focusTaskId: "history" })?.id).toBe("history");
  });
  it("allows selecting skipped history without counting it as completed", () => {
    const finished = task("skip", "skipped");
    expect(selectTodayTask({ ...emptyGroups(), done: [finished] }, { selectedId: "skip", doneView: true })).toBe(finished);
  });
});

function observer() {
  return { isCurrent: () => true, tasks: vi.fn(), plan: vi.fn(), taskError: vi.fn(), planError: vi.fn() };
}
const plan = { date: "2026-10-10", acceptedVersion: 0, blocks: [], hardBlocks: [] };

describe("today reads fail independently", () => {
  it("keeps tasks usable when the plan API fails and does not call optional reminders", async () => {
    const callbacks = observer();
    const tasks = [task("learn")];
    const api = { listTasks: vi.fn().mockResolvedValue({ tasks }), getToday: vi.fn().mockRejectedValue(new Error("plan unavailable")), listReminders: vi.fn().mockRejectedValue(new Error("reminders unavailable")) };
    await readTodayData(api, plan.date, callbacks);
    expect(callbacks.tasks).toHaveBeenCalledWith(tasks);
    expect(callbacks.planError).toHaveBeenCalledOnce();
    expect(callbacks.taskError).not.toHaveBeenCalled();
    expect(api.listReminders).not.toHaveBeenCalled();
  });
  it("renders tasks before a slow plan response completes", async () => {
    let resolvePlan!: (value: typeof plan) => void;
    const slowPlan = new Promise<typeof plan>(resolve => { resolvePlan = resolve; });
    const callbacks = observer();
    const read = readTodayData({ listTasks: async () => ({ tasks: [task("learn")] }), getToday: () => slowPlan }, plan.date, callbacks);
    await Promise.resolve();
    expect(callbacks.tasks).toHaveBeenCalledOnce();
    expect(callbacks.plan).not.toHaveBeenCalled();
    resolvePlan(plan);
    await read;
    expect(callbacks.plan).toHaveBeenCalledWith(plan);
  });
  it("reports task-read failure instead of showing a false empty state", async () => {
    const callbacks = observer();
    const failure = new Error("task unavailable");
    await readTodayData({ listTasks: async () => { throw failure; }, getToday: async () => plan }, plan.date, callbacks);
    expect(callbacks.tasks).not.toHaveBeenCalled();
    expect(callbacks.taskError).toHaveBeenCalledWith(failure);
    expect(callbacks.plan).toHaveBeenCalledWith(plan);
  });
  it("ignores late results and failures from a superseded read or unmounted view", async () => {
    const callbacks = { ...observer(), isCurrent: () => false };
    await readTodayData({ listTasks: async () => ({ tasks: [task("old")] }), getToday: async () => { throw new Error("old failure"); } }, plan.date, callbacks);
    expect(callbacks.tasks).not.toHaveBeenCalled();
    expect(callbacks.planError).not.toHaveBeenCalled();
  });
});

describe("manual plan proposal intent", () => {
  const input = { date: "2026-10-10", free: [{ start: "2026-10-10T09:00:00Z", end: "2026-10-10T10:00:00Z", kind: "free" }], baseVersion: 0 };
  it("reuses the same identifier after a failed request with unchanged input", () => {
    const mint = vi.fn().mockReturnValue("first");
    const first = planProposalIntent(null, input, mint);
    expect(planProposalIntent(first, { ...input }, mint)).toBe(first);
    expect(mint).toHaveBeenCalledOnce();
  });
  it.each([
    { ...input, date: "2026-10-11" },
    { ...input, baseVersion: 1 },
    { ...input, free: [{ ...input.free[0]!, end: "2026-10-10T11:00:00Z" }] },
    { ...input, free: [...input.free, { start: "2026-10-10T09:30:00Z", end: "2026-10-10T10:00:00Z", kind: "class" }] },
  ])("uses a new identifier for changed planning intent %#", changed => {
    const first = planProposalIntent(null, input, () => "first");
    expect(planProposalIntent(first, changed, () => "second").clientKey).toBe("second");
  });
  it("starts a new proposal after the previous one was accepted or rejected", () => {
    expect(planProposalIntent(null, input, () => "new-intent").clientKey).toBe("new-intent");
  });
});

it("focuses priority actions after their mobile container opens, without writing learning data", async () => {
  const { focusPriorityActions } = await import("./today-task-selection");
  expect(focusPriorityActions(null)).toBe(false);
  const element = { scrollIntoView: vi.fn(), focus: vi.fn() };
  expect(focusPriorityActions(element)).toBe(true);
  expect(element.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  expect(element.focus).toHaveBeenCalledWith({ preventScroll: true });
});
