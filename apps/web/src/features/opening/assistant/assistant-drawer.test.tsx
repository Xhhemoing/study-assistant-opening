// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAssistantDrawer } from "./assistant-entry";

let pathname = "/opening/today";
const query = new URLSearchParams();
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useSearchParams: () => query }));
vi.mock("./assistant-view", () => ({ AssistantView: ({ studyContext }: { studyContext?: { fragment?: string } }) => {
  const [draft, setDraft] = useState("");
  return <><p>{studyContext?.fragment ?? "自由交流"}</p><button data-draft type="button" onClick={() => setDraft(value => value + "保留")}>{draft || "空草稿"}</button></>;
} }));
import { AssistantDrawer } from "./assistant-drawer";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  pathname = "/opening/today";
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
  it("intercepts an ordinary assistant link and leaves modified links to the browser", async () => {
    await render();
    const link = document.createElement("a"); link.href = "/opening/assistant?fragment=linked"; host.appendChild(link);
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => { link.dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("linked");
    // Prevent jsdom's unrelated navigation after checking that our handler left it alone.
    let preventedByDrawer = true;
    link.addEventListener("click", event => { preventedByDrawer = event.defaultPrevented; event.preventDefault(); });
    await act(async () => { link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })); });
    expect(preventedByDrawer).toBe(false);
  });
});
