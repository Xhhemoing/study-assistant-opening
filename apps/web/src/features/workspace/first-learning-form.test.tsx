// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../opening/v3/motion/view-transition", () => ({ TransitionLink: "a" }));
vi.mock("./first-learning-materials", () => ({ FirstLearningMaterials: () => null }));
import { FirstLearningForm } from "./first-learning-form";
import { readFirstLearningDraft } from "./first-learning-draft";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.sessionStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render(reply: unknown, failed = false) {
  vi.stubGlobal("fetch", failed ? vi.fn().mockRejectedValue(new Error("network unavailable")) : vi.fn().mockImplementation(async () => Response.json(reply)));
  await act(async () => root.render(<FirstLearningForm draftKey="first-learning-test" onStarted={() => {}} />));
}
it.each([
  { items: [{ key: "available_model", ok: true, severity: "hard", detail: "ready", fixHint: "" }] },
  { items: [{ key: "vision_model", ok: false, severity: "soft", detail: "no vision", fixHint: "" }] },
  { items: [{ key: "available_model", detail: "incomplete" }] },
  { items: [{ key: "available_model", ok: false, severity: "hard", status: "unknown", detail: "未确认", fixHint: "" }] },
  { items: "invalid" },
])("keeps the first-learning form quiet unless a valid hard blocker is confirmed", async reply => {
  await render(reply);
  expect(host.textContent).not.toContain("AI 不可用时仍保留目标");
  expect(host.querySelector('[aria-label="AI 就绪提醒"]')).toBeNull();
});
it("does not interpret a network failure as confirmed AI unavailability", async () => {
  await render(null, true);
  expect(host.querySelector('[aria-label="AI 就绪提醒"]')).toBeNull();
  expect(host.querySelector("#first-topic")).not.toBeNull();
});
it("keeps dismissal across remounts only for the same draft key without losing drafts", async () => {
  await render({ items: [{ key: "available_model", ok: false, severity: "hard", detail: "当前没有可用模型", fixHint: "检查模型设置" }] });
  const input = host.querySelector<HTMLInputElement>("#first-topic")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "矩阵学习草稿");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelector('[aria-label="AI 就绪提醒"]')?.textContent).toContain("当前没有可用模型");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭 AI 就绪提醒"]')!.click());
  expect(host.querySelector('[aria-label="AI 就绪提醒"]')).toBeNull();
  expect(input.value).toBe("矩阵学习草稿");
  expect(readFirstLearningDraft(window.sessionStorage, "first-learning-test")?.topic).toBe("矩阵学习草稿");
  await act(async () => root.render(null));
  await act(async () => root.render(<FirstLearningForm draftKey="first-learning-test" onStarted={() => {}} />));
  expect(host.querySelector('[aria-label="AI 就绪提醒"]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>("#first-topic")?.value).toBe("矩阵学习草稿");
  expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await act(async () => root.render(<FirstLearningForm draftKey="another-account-draft" onStarted={() => {}} />));
  expect(host.querySelector('[aria-label="AI 就绪提醒"]')?.textContent).toContain("当前没有可用模型");
  const otherInput = host.querySelector<HTMLInputElement>("#first-topic")!;
  expect(otherInput.value).toBe("");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(otherInput, "另一个账号的草稿");
    otherInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(readFirstLearningDraft(window.sessionStorage, "another-account-draft")?.topic).toBe("另一个账号的草稿");
  expect(readFirstLearningDraft(window.sessionStorage, "first-learning-test")?.topic).toBe("矩阵学习草稿");
});
it("still dismisses locally and preserves editable input when session storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage disabled"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage disabled"); });
  await render({ items: [{ key: "available_model", ok: false, severity: "hard", detail: "当前没有可用模型", fixHint: "检查模型设置" }] });
  const input = host.querySelector<HTMLInputElement>("#first-topic")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "保留当前草稿");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[aria-label="关闭 AI 就绪提醒"]')!.click();
  });
  expect(host.querySelector('[aria-label="AI 就绪提醒"]')).toBeNull();
  expect(input.value).toBe("保留当前草稿");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});

it("starts from one topic with optional constraints and navigates to the actual unscheduled activity", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const href = `/opening/courses/${id}/study?activity=${id}`;
  const started = vi.fn();
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(init?.method === "POST"
    ? { activityId: id, taskId: null, courseId: id, href } : { items: [] }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<FirstLearningForm draftKey="unscheduled" onStarted={started} />));
  expect(host.querySelector('input[type="time"]')).toBeNull();
  expect(host.querySelector("details")?.open).toBe(false);
  expect(host.textContent).not.toContain("19:00");
  const topic = host.querySelector<HTMLInputElement>("#first-topic")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(topic, "向量张成");
    topic.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(started).toHaveBeenCalledExactlyOnceWith(href);
  const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(String(post[1]?.body))).toMatchObject({ topic: "向量张成", minutes: 20, startTime: null });
  expect(JSON.parse(String(post[1]?.body))).not.toHaveProperty("dailyMinutes");
});

it("keeps an old explicit schedule and its retry identity when the saved draft is resumed", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const saved = { clientKey: id, topic: "旧目标", goal: "保留原意图", targetDate: "", minutes: 30, startTime: "19:00", timeZone: "Asia/Shanghai", sourceIds: [] };
  window.sessionStorage.setItem("scheduled", JSON.stringify(saved));
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(init?.method === "POST"
    ? { activityId: id, taskId: id, href: "/opening/today" } : { items: [] }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<FirstLearningForm draftKey="scheduled" onStarted={() => {}} />));
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[type="time"]')?.value).toBe("19:00");
  expect(host.textContent).toContain("每天 19:00");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(String(post[1]?.body))).toEqual({ ...saved, targetDate: null });
});

it("requires an explicitly selected start time only when fixed scheduling is requested", async () => {
  await render({ items: [] });
  const topic = host.querySelector<HTMLInputElement>("#first-topic")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(topic, "矩阵");
    topic.dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  });
  const time = host.querySelector<HTMLInputElement>('input[type="time"]')!;
  expect(time.value).toBe("");
  expect(time.required).toBe(true);
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain("请选择开始时刻");
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
