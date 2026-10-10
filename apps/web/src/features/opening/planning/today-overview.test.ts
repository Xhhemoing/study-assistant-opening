import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskItem } from "@aistudy/contracts";
import { summarizeTodayPlan, TodayLearningContext, TodayPlanOverview } from "./today-overview";

const task = (id: string, status: TaskItem["status"]): TaskItem => ({ id, title: id, status, minutes: 90, dueAt: null, priority: 1 });
const block = (taskId: string, start: string, end: string) => ({ taskId, start: `2026-09-30T${start}:00Z`, end: `2026-09-30T${end}:00Z`, reason: "已确认的时间安排" });
const plan = { date: "2026-09-30", acceptedVersion: 2, hardBlocks: [], blocks: [
  block("pending", "08:00", "08:15"), block("pending", "09:00", "09:10"),
  block("done", "10:00", "10:20"), block("skipped", "11:00", "11:30"), block("missing", "12:00", "12:10"),
] };

describe("confirmed daily plan summary", () => {
  it("counts distinct planned tasks and uses their remaining scheduled minutes, excluding unrelated history", () => {
    expect(summarizeTodayPlan([task("pending", "pending"), task("done", "done"), task("skipped", "skipped"), task("old-done", "done"), task("unplanned", "pending")], plan))
      .toEqual({ total: 4, done: 1, pending: 1, pendingMinutes: 25, skipped: 1, unavailable: 1 });
  });

  it("does not invent a completion state for unavailable tasks", () => {
    const html = renderToStaticMarkup(createElement(TodayPlanOverview, { tasks: [], plan, onArrange: () => undefined }));
    expect(html).toContain("0/4 项");
    expect(html).toContain("4 项暂不在当前队列中");
    expect(html).toContain("完成时间可能早于今天");
    expect(html).toContain("不是实际学习时长");
  });

  it("offers arranging time before a plan is accepted without treating the full queue as the plan", () => {
    const html = renderToStaticMarkup(createElement(TodayPlanOverview, { tasks: [task("pending", "pending")], plan: { ...plan, acceptedVersion: 0, blocks: [] }, onArrange: () => undefined }));
    expect(html).toContain("安排可用时间");
    expect(html).not.toContain("90 分钟");
    expect(html).not.toContain("0/0");
  });

  it("distinguishes an accepted empty plan from an unconfirmed plan", () => {
    const html = renderToStaticMarkup(createElement(TodayPlanOverview, { tasks: [], plan: { ...plan, blocks: [] }, onArrange: () => undefined }));
    expect(html).toContain("已确认的计划没有学习任务");
    expect(html).not.toContain("还未确认");
  });
});

describe("Today learning context", () => {
  it("preserves reading position and a course-specific route without adding an AI prerequisite", () => {
    const html = renderToStaticMarkup(createElement(TodayLearningContext, { item: { conversationId: "conversation", title: "矩阵复习", courseId: "course/one", currentPage: 7, sourceVersions: { sourceA: 1, sourceB: 0 } } }));
    expect(html).toContain("第 7 页");
    expect(html).toContain("可恢复 2 份材料");
    expect(html).toContain('href="/opening/courses/course%2Fone"');
    expect(html).not.toContain('href="/library/new"');
  });

  it("keeps manually readable materials separate from automatic resume and page recovery", () => {
    const html = renderToStaticMarkup(createElement(TodayLearningContext, { item: { conversationId: "conversation", title: "矩阵复习", courseId: "course", currentPage: null, sourceVersions: {}, manualSourceCount: 1 } }));
    expect(html).toContain("1 份材料仅供手工阅读，已停止供 AI 使用；可在材料页查看。");
    expect(html).toContain("可继续上次保存的对话");
    expect(html).not.toContain("可恢复");
    expect(html).not.toContain("上次读到第");
  });

  it("shows automatic and manual material counts distinctly while keeping existing navigation", () => {
    const html = renderToStaticMarkup(createElement(TodayLearningContext, { item: { conversationId: "conversation", title: "矩阵复习", courseId: "course", currentPage: null, sourceVersions: { sourceA: 3 }, manualSourceCount: 1 } }));
    expect(html).toContain("上次学习：矩阵复习");
    expect(html).toContain("可恢复 1 份材料");
    expect(html).toContain("1 份材料仅供手工阅读");
    expect(html).not.toContain("可恢复 2 份材料");
    expect(html).toContain('href="/opening/courses/course"');
    expect(html).not.toContain('href="/library/new"');
  });
  it("keeps course practice and notes reachable without a saved conversation", () => {
    const html = renderToStaticMarkup(createElement(TodayLearningContext));
    expect(html).toContain('href="/opening/courses"');
    expect(html).not.toContain('href="/library/new"');
    expect(html).not.toContain("上次学习");
    expect(html).not.toContain("可恢复 0 份材料");
  });

  it("surfaces compact Opening loop links without inventing new product routes", () => {
    const html = renderToStaticMarkup(createElement(TodayLearningContext));
    expect(html).toContain('data-today-loop-links="true"');
    expect(html).toContain('href="/opening/cards"');
    expect(html).toContain('href="/opening/review"');
    expect(html).toContain('href="/opening/settings/connections"');
    expect(html).toContain('href="#action-digest"');
    expect(html).toContain("课程知识 / 材料在课程页");
    expect(html).toContain('href="/opening/courses"');
  });
});