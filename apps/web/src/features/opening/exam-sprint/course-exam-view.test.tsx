// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CourseExamOverview } from "@aistudy/contracts";
import { CourseExamView } from "./course-exam-view";
import { CourseExamProgress } from "./course-exam-progress";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";

vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) => createElement("a", { href, className }, children as never) }));
const course = "11111111-1111-4111-8111-111111111111", source = "22222222-2222-4222-8222-222222222222";
const initial: CourseExamOverview = { courseId: course, courseTitle: "线性代数", targetDate: "2026-10-31", dailyMinutes: 60,
  sources: [{ id: source, title: "2025 年真题", version: 1 }], papers: [] };
let container: HTMLDivElement, root: Root;
let clearIdentity: () => void;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("fetch", fetchMock); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.sessionStorage.clear();
  clearIdentity = publishVerifiedSessionIdentity({ id: "owner", workspaceId: "workspace" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); clearIdentity(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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

it("restores an unknown request with a read before an explicit same-key retry and locks implicit input changes", async () => {
  fetchMock.mockRejectedValueOnce(new Error("connection lost"));
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  await click("分析考点并组卷");
  const original = JSON.parse(fetchMock.mock.calls[0]![1].body);
  await act(async () => root.render(null));
  const unknown: CourseExamOverview = { ...initial, papers: [{ id: source, clientKey: original.clientKey, sourceTitle: "原真题",
    createdAt: "2026-10-22T08:00:00Z", status: "unknown", title: null, topics: [], questionCount: 5, activityId: null, available: true }] };
  fetchMock.mockImplementation(() => Promise.resolve(Response.json(unknown)));
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  expect(fetchMock.mock.calls).toHaveLength(2);
  expect(fetchMock.mock.calls[1]![1].method).toBeUndefined();
  expect([...container.querySelectorAll("select,input")].every(input => (input as HTMLInputElement).disabled)).toBe(true);
  await click("查看这次组卷结果");
  expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual(original);
  expect(container.textContent).toContain("尚未收到完整结果");
  expect(container.textContent).toContain("另开一份练习");
  await click("另开一份练习");
  expect([...container.querySelectorAll("select,input")].every(input => !(input as HTMLInputElement).disabled)).toBe(true);
});

it("clears the checkpoint only after reading a ready result on re-entry", async () => {
  fetchMock.mockRejectedValueOnce(new Error("response lost"));
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  await click("分析考点并组卷");
  const original = JSON.parse(fetchMock.mock.calls[0]![1].body);
  await act(async () => root.render(null));
  fetchMock.mockResolvedValueOnce(Response.json({ ...initial, papers: [{ id: source, clientKey: original.clientKey, sourceTitle: "原真题",
    createdAt: "2026-10-22T08:00:00Z", status: "ready", title: "已完成试卷", topics: [], questionCount: 5, activityId: source, available: true }] }));
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  expect(container.textContent).toContain("开始模拟练习");
  expect(container.textContent).not.toContain("查看这次组卷结果");
  expect(window.sessionStorage.length).toBe(0);
});

it("does not send a request that cannot be persisted", async () => {
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
  await click("分析考点并组卷");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("尚未发送");
});

it.each([{ id: "other-owner", workspaceId: "workspace" }, { id: "owner", workspaceId: "other-workspace" }])("isolates recovery from $id in $workspaceId", async identity => {
  fetchMock.mockRejectedValue(new Error("response lost"));
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  await click("分析考点并组卷");
  const original = JSON.parse(fetchMock.mock.calls[0]![1].body);
  await act(async () => root.render(null));
  clearIdentity(); clearIdentity = publishVerifiedSessionIdentity(identity);
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  expect(fetchMock.mock.calls).toHaveLength(1);
  await click("分析考点并组卷");
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body).clientKey).not.toBe(original.clientKey);
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
