// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { CurrentStudyContext } from "../assistant/current-study-context";
const probe = vi.hoisted(() => ({ context: null as unknown, request: null as unknown, focus: vi.fn() }));
vi.mock("../shell/workspace-layout-context", () => ({ useWorkspaceLayout: () => ({ focusMode: false, setFocusMode: probe.focus }) }));
vi.mock("./study-context-tools", () => ({ StudyContextTools: (props: { context: unknown; askRequest: unknown }) => { probe.context = props.context; probe.request = props.askRequest; return null; } }));
vi.mock("./conversation-companion-tabs", () => ({ ConversationCompanionTabs: ({ children }: { children: ReactNode }) => children }));
vi.mock("./study-tools-panel", () => ({ StudyToolsPanel: ({ children, panels, activePanel }: { children: ReactNode; panels: { content: ReactNode }[]; activePanel: string | null }) => createElement("div", { "data-panel": activePanel }, children, panels[0]?.content) }));
import { LessonCompanionWorkspace } from "./lesson-companion-workspace";
import { SelectionAsk } from "./selection-ask";

it("keeps native lesson DOM and canonical attempt while selection opens its existing companion", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const id = crypto.randomUUID();
  const binding: CurrentStudyContext = { isQuestion: true, learningAttempt: { id } as NonNullable<CurrentStudyContext["learningAttempt"]>,
    context: { attemptId: id, itemVersionId: id, label: "本题" } };
  try {
    await act(async () => root.render(createElement(LessonCompanionWorkspace, { binding, outline: null,
      children: createElement(SelectionAsk, { binding, children: createElement("p", { "data-catalog": "text" }, "选中的原文") }) })));
    const paragraph = host.querySelector("p")!;
    const range = document.createRange(); range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    const ask = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "问选中内容")!;
    await act(async () => ask.click());
    expect(host.firstElementChild?.getAttribute("data-panel")).toBe("chat");
    expect(host.querySelector("p")).toBe(paragraph);
    expect(probe.context).toBe(binding.context);
    expect(probe.request).toMatchObject({ text: "请补充解释这段内容：\n选中的原文" });
    expect(host.querySelector("a")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges(); }
});
