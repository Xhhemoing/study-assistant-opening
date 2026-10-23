// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentStudyContext } from "./current-study-context";
import { openAssistantDrawer } from "./assistant-entry";

let pathname = "/opening/today";
const query = new URLSearchParams();
let bound: (CurrentStudyContext & { pathname: string }) | null = null;
vi.mock("./current-study-context", () => ({ useCurrentStudyContext: () => bound }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useSearchParams: () => query }));
vi.mock("./assistant-view", () => ({ AssistantView: ({ studyContext, studyContextError }: { studyContext?: { fragment?: string }; studyContextError?: string }) => {
  const [draft, setDraft] = useState("");
  if (studyContextError) return <p role="alert">{studyContextError}</p>;
  return <><p>{studyContext?.fragment ?? "自由交流"}</p><button data-draft type="button" onClick={() => setDraft(value => value + "保留")}>{draft || "空草稿"}</button></>;
} }));
import { AssistantDrawer } from "./assistant-drawer";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  pathname = "/opening/today";
  bound = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => (element as HTMLElement).click());
}
async function render() { await act(async () => root.render(<AssistantDrawer />)); }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }

describe("global assistant drawer lifetime", () => {
  it("retains the same draft after closing and navigation, with no hidden dialog in the document", async () => {
    await render();
    await act(async () => openAssistantDrawer());
    await click(document.querySelector("[data-draft]"));
    await click(document.querySelector('[aria-label="关闭抽屉"]'));
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    pathname = "/opening/courses";
    await render();
    await act(async () => openAssistantDrawer());
    expect(document.querySelector("[data-draft]")?.textContent).toBe("保留");
  });
  it("keeps different selected contexts and their drafts when switching questions", async () => {
    await render();
    await act(async () => openAssistantDrawer("/opening/assistant?fragment=first"));
    await click(document.querySelector("[data-draft]"));
    await act(async () => openAssistantDrawer("/opening/assistant?fragment=second"));
    const select = document.querySelector<HTMLSelectElement>('[aria-label="切换本次提问"]')!;
    expect(select.options).toHaveLength(2);
    const oldQuestion = Array.from(document.querySelectorAll("[data-draft]")).find(button => button.textContent === "保留")!;
    expect(oldQuestion.closest("[inert]")).not.toBeNull();
    await act(async () => { select.value = select.options[0]!.value; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(oldQuestion.closest("[inert]")).toBeNull();
  });
  it("protects an unsubmitted question registered on Today and hides previous session switching", async () => {
    await render();
    await act(async () => openAssistantDrawer("/opening/assistant?fragment=previous"));
    await act(async () => openAssistantDrawer("/opening/assistant?fragment=another"));
    bound = { pathname, context: { courseId: "11111111-1111-4111-8111-111111111111", activityId: "22222222-2222-4222-8222-222222222222", blockId: "33333333-3333-4333-8333-333333333333", contentVersion: 1, label: "当前题" }, isQuestion: true, blockedReason: "先保存自己的原答案" };
    await render();
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => openAssistantDrawer());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("先保存自己的原答案");
    expect(document.querySelector('[aria-label="切换本次提问"]')).toBeNull();
    expect(document.querySelector('[role="dialog"] [data-draft]:not([hidden])')?.closest('[inert]')).not.toBeNull();
  });
  it("reopens the current Today item after a step changes instead of resuming its previous conversation", async () => {
    bound = { pathname, context: { courseId: "11111111-1111-4111-8111-111111111111", fragment: "first lecture", label: "第一步" }, isQuestion: false };
    await render();
    await act(async () => openAssistantDrawer());
    await click(document.querySelector("[data-draft]"));
    bound = { ...bound, context: { ...bound.context, fragment: "second lecture", label: "第二步" } };
    await render(); await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => openAssistantDrawer());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('[inert]')?.textContent).toContain("保留");
    expect(dialog?.textContent).toContain("第二步");
    expect(document.querySelector('[aria-label="切换本次提问"]')).toBeNull();
  });
  it("leaves ordinary assistant history links to normal navigation", async () => {
    await render();
    const link = document.createElement("a"); link.href = "/opening/assistant?conversation=saved"; host.appendChild(link);
    let intercepted = true;
    link.addEventListener("click", event => { intercepted = event.defaultPrevented; event.preventDefault(); });
    await act(async () => { link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
    expect(intercepted).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("does not register a default Ctrl J shortcut", async () => {
    await render();
    const shortcut = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "j", ctrlKey: true });
    await act(async () => { document.dispatchEvent(shortcut); });
    expect(shortcut.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
