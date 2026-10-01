import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolveTodayResume, todayConfirmHref } from "./today-read";
import { TodayResumeBody } from "./today-resume-view";
import { visibleTodayTasks } from "./today-task-selection";

const conversation = { id: "11111111-1111-4111-8111-111111111111", title: "线性代数答疑", lastUserText: "如何判断矩阵可逆？", currentPage: 7 };
describe("independent Today resume and review state", () => {
  it.each([
    [{ hasSession: false, loadFailed: false }, "loggedOut"],
    [{ hasSession: true, loadFailed: true }, "error"],
    [{ hasSession: true, loadFailed: false }, "empty"],
  ] as const)("classifies %j without inventing data", (input, kind) => {
    expect(resolveTodayResume(input)).toEqual({ kind });
  });
  it("keeps continue and pending review navigation visible together", () => {
    const state = resolveTodayResume({ hasSession: true, loadFailed: false, lastConversation: conversation, pendingConfirmations: 3 });
    expect(state.kind).toBe("ready");
    expect(state.continueItem).toMatchObject({ conversationId: conversation.id, currentPage: 7 });
    expect(state.pendingReviews).toEqual({ count: 3, href: "/opening/review" });
    const html = renderToStaticMarkup(createElement(TodayResumeBody, { state }));
    expect(html).toContain(`/opening/assistant?conversation=${conversation.id}`);
    expect(html).toContain('href="/opening/review"');
    expect(html).not.toContain("/api/");
    expect(html).not.toContain("请先处理");
  });
  it("offers review even without a saved conversation", () => {
    const state = resolveTodayResume({ hasSession: true, loadFailed: false, pendingConfirmations: 1 });
    expect(state.continueItem).toBeUndefined();
    expect(state.pendingReviews?.count).toBe(1);
  });
  it("retains continue when there are no pending suggestions", () => {
    expect(resolveTodayResume({ hasSession: true, loadFailed: false, lastConversation: conversation }).continueItem?.conversationId).toBe(conversation.id);
  });
  it.each(["memory", "task", "retest"])("uses the review page for %s, never a mutation API", (kind) => {
    expect(todayConfirmHref([{ id: "candidate", payload: { kind } }])).toBe("/opening/review");
  });
  it("renders a read failure without pretending the list is empty", () => {
    const html = renderToStaticMarkup(createElement(TodayResumeBody, { state: { kind: "error" } }));
    expect(html).toContain("暂时无法读取");
    expect(html).not.toContain("还没有学习记录");
  });
  it("links a returned task even when it is outside the first three or already completed", () => {
    const tasks = ["a", "b", "c", "d"].map((id) => ({ id, title: id, minutes: 20, priority: 1, dueAt: null, status: "pending" as const }));
    expect(visibleTodayTasks(tasks, "d").map((task) => task.id)).toEqual(["d", "a", "b"]);
    expect(visibleTodayTasks([{ ...tasks[0]!, status: "done" }], "a")[0]?.status).toBe("done");
  });
});

it("keeps manual material separate from automatic resume and preserves the conversation link", () => {
  const state = resolveTodayResume({ hasSession: true, loadFailed: false,
    lastConversation: { ...conversation, sourceVersions: {}, currentPage: null, manualSourceCount: 1 } });
  expect(state.continueItem?.manualSourceCount).toBe(1);
  const html = renderToStaticMarkup(createElement(TodayResumeBody, { state }));
  expect(html).toContain(`/opening/assistant?conversation=${conversation.id}`);
  expect(html).toContain(conversation.lastUserText);
  expect(html).toContain("1 份材料仅供手工阅读");
  expect(html).not.toContain("上次读到第");
  expect(html).not.toContain("可恢复");
});
it("describes only automatic materials as recoverable", () => {
  const state = resolveTodayResume({ hasSession: true, loadFailed: false,
    lastConversation: { ...conversation, sourceVersions: { "33333333-3333-4333-8333-333333333333": 4 }, currentPage: null, manualSourceCount: 1 } });
  const html = renderToStaticMarkup(createElement(TodayResumeBody, { state }));
  expect(html).toContain("可恢复 1 份材料");
  expect(html).toContain("1 份材料仅供手工阅读");
  expect(html).not.toContain("上次读到第");
});
