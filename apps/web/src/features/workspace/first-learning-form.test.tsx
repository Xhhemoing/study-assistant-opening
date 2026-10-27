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
