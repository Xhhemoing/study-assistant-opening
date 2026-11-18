// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CourseExamOverview } from "@aistudy/contracts";
import { CourseExamView } from "./course-exam-view";
import { CourseExamProgress } from "./course-exam-progress";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";

vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) => createElement("a", { href, className }, children as never) }));
const course = "11111111-1111-4111-8111-111111111111", source = "22222222-2222-4222-8222-222222222222", otherSource = "33333333-3333-4333-8333-333333333333";
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
async function chooseSource(value: string) {
  const select = container.querySelector("select") as HTMLSelectElement | null;
  expect(select).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("defaults to the first source that appears after refresh and can continue with it", async () => {
  const refreshed: CourseExamOverview = { ...initial, sources: [{ id: source, title: "新真题", version: 1 }, { id: otherSource, title: "另一份真题", version: 1 }] };
  fetchMock.mockResolvedValueOnce(Response.json(refreshed)).mockResolvedValueOnce(Response.json(refreshed));
  await act(async () => root.render(createElement(CourseExamView, { initial: { ...initial, sources: [] } })));
  await click("刷新材料与结果");
  expect((container.querySelector("select") as HTMLSelectElement).value).toBe(source);
  const generateButton = [...container.querySelectorAll("button")].find(item => item.textContent === "分析考点并组卷") as HTMLButtonElement | undefined;
  expect(generateButton?.disabled).toBe(false);
  await click("分析考点并组卷");
  expect(fetchMock.mock.calls[1]![1].method).toBe("POST");
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body).sourceId).toBe(source);
});

it("keeps a user-selected source when refresh still returns it", async () => {
  const refreshed: CourseExamOverview = { ...initial, sources: [{ id: source, title: "真题", version: 2 }, { id: otherSource, title: "另一份真题", version: 1 }] };
  fetchMock.mockResolvedValue(Response.json(refreshed));
  await act(async () => root.render(createElement(CourseExamView, { initial: { ...initial, sources: refreshed.sources } })));
  await act(async () => { await Promise.resolve(); });
  expect((container.querySelector("select") as HTMLSelectElement).value).toBe(source);
  expect((container.querySelector("select") as HTMLSelectElement).disabled).toBe(false);
  await chooseSource(otherSource);
  expect((container.querySelector("select") as HTMLSelectElement).value).toBe(otherSource);
  await click("刷新材料与结果");
  expect((container.querySelector("select") as HTMLSelectElement).value).toBe(otherSource);
});

it("clears a selected source that disappears after refresh and blocks a new paper", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ ...initial, sources: [{ id: source, title: "真题", version: 2 }] }));
  await act(async () => root.render(createElement(CourseExamView, { initial: { ...initial, sources: [
    { id: source, title: "真题", version: 1 }, { id: otherSource, title: "将失效的真题", version: 1 },
  ] } })));
  await act(async () => { await Promise.resolve(); });
  await chooseSource(otherSource);
  await click("刷新材料与结果");
  const generateButton = [...container.querySelectorAll("button")].find(item => item.textContent === "分析考点并组卷") as HTMLButtonElement | undefined;
  expect((container.querySelector("select") as HTMLSelectElement).value).toBe("");
  expect(generateButton?.disabled).toBe(true);
  expect(container.textContent).toContain("已选择的材料已不可用");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("keeps a checkpoint when its source disappears and refresh stays read-only", async () => {
  fetchMock.mockRejectedValueOnce(new Error("connection lost"));
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  await click("分析考点并组卷");
  const original = JSON.parse(fetchMock.mock.calls[0]![1].body);
  await act(async () => root.render(null));
  fetchMock.mockResolvedValueOnce(Response.json({ ...initial, sources: [], papers: [{ id: source, clientKey: original.clientKey, sourceTitle: "原真题",
    createdAt: "2026-10-22T08:00:00Z", status: "unknown", title: null, topics: [], questionCount: 5, activityId: null, available: false }] }));
  await act(async () => root.render(createElement(CourseExamView, { initial: { ...initial, sources: [] } })));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]![1].method).toBeUndefined();
  const checkpoint = window.sessionStorage.getItem(Object.keys(window.sessionStorage)[0]!);
  expect(JSON.parse(checkpoint!).input).toEqual(original);
  expect(container.textContent).toContain("原组卷请求已保留");
  expect(container.textContent).toContain("另开一份练习");
});

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

it.each(["ready", "failed"] as const)("requires a new source after the removed source's request is %s", async status => {
  fetchMock.mockRejectedValueOnce(new Error("response lost"));
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  await click("分析考点并组卷");
  const original = JSON.parse(fetchMock.mock.calls[0]![1].body);
  await act(async () => root.render(null));
  const replacement: CourseExamOverview = { ...initial, sources: [{ id: otherSource, title: "现有真题", version: 1 }] };
  fetchMock.mockResolvedValueOnce(Response.json({ ...replacement, papers: [{
    id: source, clientKey: original.clientKey, sourceTitle: "原真题", createdAt: "2026-10-22T08:00:00Z",
    status, title: null, topics: [], questionCount: 5, activityId: status === "ready" ? source : null, available: false,
  }] })).mockResolvedValueOnce(Response.json(replacement));
  await act(async () => root.render(createElement(CourseExamView, { initial: replacement })));
  expect(fetchMock.mock.calls[1]![1].method).toBeUndefined();
  expect(window.sessionStorage.length).toBe(0);
  await click("分析考点并组卷");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const generate = [...container.querySelectorAll("button")].find(button => button.textContent === "分析考点并组卷");
  expect(generate?.disabled).toBe(true);
  await chooseSource(otherSource);
  await click("分析考点并组卷");
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2]![1].method).toBe("POST");
  expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toMatchObject({ sourceId: otherSource });
  expect(JSON.parse(fetchMock.mock.calls[2]![1].body).clientKey).not.toBe(original.clientKey);
});

it.each(["pending", "unknown"] as const)("replays a removed source's %s request, then requires a current source when starting another paper", async status => {
  fetchMock.mockRejectedValueOnce(new Error("response lost"));
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  await click("分析考点并组卷");
  const original = JSON.parse(fetchMock.mock.calls[0]![1].body);
  const replacement: CourseExamOverview = { ...initial, sources: [{ id: otherSource, title: "现有真题", version: 1 }] };
  const unresolved: CourseExamOverview = { ...replacement, papers: [{
    id: source, clientKey: original.clientKey, sourceTitle: "原真题", createdAt: "2026-10-22T08:00:00Z",
    status, title: null, topics: [], questionCount: 5, activityId: null, available: false,
  }] };
  fetchMock.mockResolvedValueOnce(Response.json(unresolved)).mockResolvedValueOnce(Response.json(unresolved))
    .mockResolvedValueOnce(Response.json(replacement));
  await click("刷新材料与结果");
  expect(fetchMock.mock.calls[1]![1].method).toBeUndefined();
  await click("查看这次组卷结果");
  expect(fetchMock.mock.calls[2]![1].method).toBe("POST");
  expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual(original);
  await click("另开一份练习");
  await click("分析考点并组卷");
  expect(fetchMock).toHaveBeenCalledTimes(3);
  const generate = [...container.querySelectorAll("button")].find(button => button.textContent === "分析考点并组卷");
  expect(generate?.disabled).toBe(true);
  await chooseSource(otherSource);
  await click("分析考点并组卷");
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock.mock.calls[3]![1].method).toBe("POST");
  expect(JSON.parse(fetchMock.mock.calls[3]![1].body)).toMatchObject({ sourceId: otherSource });
  expect(JSON.parse(fetchMock.mock.calls[3]![1].body).clientKey).not.toBe(original.clientKey);
});

async function setPageInput(labelText: string, value: string) {
  const label = [...container.querySelectorAll("label")].find(item => item.textContent?.startsWith(labelText));
  const input = label?.querySelector("input") as HTMLInputElement | null;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("validates page range and positive integer pages pre-POST without locking the form", async () => {
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  await setPageInput("起始页", "5");
  await setPageInput("结束页", "2");
  await click("分析考点并组卷");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(window.sessionStorage.length).toBe(0);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("起始页不能大于结束页");
  expect([...container.querySelectorAll("select,input")].every(el => !(el as HTMLInputElement).disabled)).toBe(true);

  await setPageInput("起始页", "0");
  await click("分析考点并组卷");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("起始页必须是大于 0 的整数");

  await setPageInput("起始页", "");
  await setPageInput("结束页", "3");
  await click("分析考点并组卷");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("先填写起始页");

  await setPageInput("起始页", "1");
  await setPageInput("结束页", "1.5");
  await click("分析考点并组卷");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("结束页必须是大于 0 的整数");

  fetchMock.mockResolvedValueOnce(Response.json(initial));
  await setPageInput("结束页", "3");
  await click("分析考点并组卷");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ sourceId: source, firstPage: 1, lastPage: 3 });
});

it("rejects non-UUID sourceId pre-POST without issuing POST", async () => {
  const invalidInitial: CourseExamOverview = { ...initial, sources: [{ id: "not-a-uuid", title: "无效ID", version: 1 }] };
  await act(async () => root.render(createElement(CourseExamView, { initial: invalidInitial })));
  await click("分析考点并组卷");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("选择有效的真题");
});

it.each([
  { status: 400, body: { error: { code: "VALIDATION", message: "试卷内容较长，请指定较小的页码范围后再组卷。" } }, expectedText: "较小的页码范围" },
  { status: 409, body: { error: { code: "CONFLICT", message: "所选试卷还没有可读取文字，请等待解析完成或调整页码。" } }, expectedText: "调整页码" },
  { status: 409, body: { error: { code: "CONFLICT", status: "failed", reason: "rejected", message: "材料已调整，请重新选择后再试。" }, status: "failed" }, expectedText: "请重新选择后再试" },
])("unlocks cleanly on deterministic $status responses so the learner can edit and resubmit", async ({ status, body, expectedText }) => {
  fetchMock
    .mockResolvedValueOnce(Response.json(body, { status }))
    .mockResolvedValueOnce(Response.json(initial));
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  await setPageInput("起始页", "1");
  await setPageInput("结束页", "20");
  await click("分析考点并组卷");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(expectedText);
  expect(window.sessionStorage.length).toBe(0);
  expect([...container.querySelectorAll("select,input")].every(el => !(el as HTMLInputElement).disabled)).toBe(true);
  expect([...container.querySelectorAll("button")].some(btn => btn.textContent === "分析考点并组卷" && !btn.disabled)).toBe(true);
  const firstKey = JSON.parse(fetchMock.mock.calls[0]![1].body).clientKey;

  await setPageInput("结束页", "5");
  await click("分析考点并组卷");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const secondBody = JSON.parse(fetchMock.mock.calls[1]![1].body);
  expect(secondBody.clientKey).not.toBe(firstKey);
  expect(secondBody).toMatchObject({ firstPage: 1, lastPage: 5 });
});

it.each([
  { label: "408", response: () => Response.json({ error: { message: "请求超时，请稍后重试。" } }, { status: 408 }) },
  { label: "503", response: () => Response.json({ error: { message: "服务暂不可用，请重试。" } }, { status: 503 }) },
  { label: "pending 409", response: () => Response.json({ error: { code: "CONFLICT", message: "正在生成中，请稍后查看。" }, status: "pending" }, { status: 409 }) },
  { label: "status unknown 409", response: () => Response.json({ error: { code: "CONFLICT", message: "组卷请求已结束，请读取已有结果。" }, status: "unknown" }, { status: 409 }) },
  { label: "error.status unknown 409", response: () => Response.json({ error: { code: "CONFLICT", status: "unknown", message: "组卷请求已结束，请读取已有结果。" } }, { status: 409 }) },
  { label: "error.reason unknown 409", response: () => Response.json({ error: { code: "CONFLICT", reason: "unknown", message: "组卷请求已结束，请读取已有结果。" } }, { status: 409 }) },
])("preserves same-key retry protection on $label", async ({ response }) => {
  fetchMock.mockResolvedValueOnce(response()).mockResolvedValueOnce(Response.json(initial));
  await act(async () => root.render(createElement(CourseExamView, { initial })));
  await click("分析考点并组卷");
  expect(window.sessionStorage.length).toBe(1);
  expect([...container.querySelectorAll("select,input")].every(el => (el as HTMLInputElement).disabled)).toBe(true);
  const firstBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
  await click("查看这次组卷结果");
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual(firstBody);
});
