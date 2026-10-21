// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CourseExamOverview } from "@aistudy/contracts";
import { CourseExamView } from "./course-exam-view";
import { CourseExamProgress } from "./course-exam-progress";

vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) => createElement("a", { href, className }, children as never) }));
const course = "11111111-1111-4111-8111-111111111111", source = "22222222-2222-4222-8222-222222222222";
const initial: CourseExamOverview = { courseId: course, courseTitle: "线性代数", targetDate: "2026-10-31", dailyMinutes: 60,
  sources: [{ id: source, title: "2025 年真题", version: 1 }], papers: [] };
let container: HTMLDivElement, root: Root;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("fetch", fetchMock); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(item => item.textContent === text);
  expect(button).toBeTruthy(); await act(async () => button!.click());
}

it("keeps the same request key after uncertain delivery and only starts another paper explicitly", async () => {
  fetchMock.mockRejectedValue(new Error("connection lost"));
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  await click("分析考点并组卷"); await click("查看这次组卷结果");
  const first = JSON.parse(fetchMock.mock.calls[0]![1].body), replay = JSON.parse(fetchMock.mock.calls[1]![1].body);
  expect(replay).toEqual(first);
  await click("另开一份练习"); await click("分析考点并组卷");
  expect(JSON.parse(fetchMock.mock.calls[2]![1].body).clientKey).not.toBe(first.clientKey);
  expect(container.querySelector('a[href*="courseId="]')?.getAttribute("href")).toContain(course);
});

it("links course progress to the generic course workflow and releases no answer content", async () => {
  const ready: CourseExamOverview = { ...initial, papers: [{ id: source, clientKey: "request-key", sourceTitle: "2025 年真题",
    createdAt: "2026-10-21T00:00:00.000Z", status: "ready", title: "模拟练习", topics: ["矩阵秩"], questionCount: 5, activityId: source, available: true }] };
  fetchMock.mockResolvedValue(new Response(JSON.stringify(ready)));
  await act(async () => root.render(createElement(CourseExamProgress, { courseId: course })));
  expect(fetchMock.mock.calls[0]![0]).toBe(`/api/opening/courses/${course}/exam`);
  expect(container.querySelector("a")?.getAttribute("href")).toBe(`/opening/courses/${course}/exam`);
  expect(container.textContent).toContain("1 份模拟练习，共 5 题");
  expect(container.textContent).not.toContain("预置考点");
});
