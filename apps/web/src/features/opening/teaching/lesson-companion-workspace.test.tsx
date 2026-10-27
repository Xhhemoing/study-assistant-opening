// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { CurrentStudyContext } from "../assistant/current-study-context";
const probe = vi.hoisted(() => ({ context: null as unknown, request: null as unknown, focus: vi.fn(), toggleFocus: vi.fn(), panels: [] as string[], showToolbar: true }));
vi.mock("../shell/workspace-layout-context", () => ({ useWorkspaceLayout: () => ({ focusMode: false, setFocusMode: probe.focus, toggleFocusMode: probe.toggleFocus }) }));
vi.mock("./study-context-tools", () => ({ StudyContextTools: (props: { context: unknown; askRequest: unknown }) => { probe.context = props.context; probe.request = props.askRequest; return null; } }));
vi.mock("./conversation-companion-tabs", () => ({ ConversationCompanionTabs: ({ children }: { children: ReactNode }) => children }));
vi.mock("../library/material-library", () => ({ MaterialLibrary: ({ courseId }: { courseId: string }) => createElement("div", { "data-material-course": courseId }, "课程资料") }));
vi.mock("./study-tools-panel", async original => ({ ...await original<typeof import("./study-tools-panel")>(), StudyToolsPanel: ({ children, panels, activePanel, showToolbar, onPanelChange }: { children: ReactNode; panels: { id: string; content: ReactNode }[]; activePanel: string | null; showToolbar: boolean; onPanelChange: (id: string) => void }) => {
  probe.panels = panels.map(panel => panel.id); probe.showToolbar = showToolbar;
  return createElement("div", { "data-panel": activePanel }, children, activePanel ? panels.map(panel => createElement("button", { key: panel.id, "data-tool-tab": panel.id, onClick: () => onPanelChange(panel.id) }, panel.id)) : null, panels.find(panel => panel.id === activePanel)?.content);
} }));
vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children) }));
import { LessonCompanionWorkspace } from "./lesson-companion-workspace";
import { SelectionAsk } from "./selection-ask";
import { explanationActionPrompt } from "./explanation-actions";
import { StudyIntentControls } from "./study-intent-controls";

it("keeps native lesson DOM and canonical attempt while selection opens its existing companion", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const id = crypto.randomUUID();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ event: null }));
  const binding: CurrentStudyContext = { isQuestion: true, learningAttempt: { id } as NonNullable<CurrentStudyContext["learningAttempt"]>,
    context: { attemptId: id, itemVersionId: id, label: "本题" } };
  try {
    await act(async () => root.render(createElement(LessonCompanionWorkspace, { binding, title: "本课", returnHref: "/opening/courses/course", progress: { current: 1, total: 3 }, outline: null,
      children: createElement("div", {}, createElement(SelectionAsk, { binding, children: createElement("p", { "data-catalog": "text" }, "选中的原文") }), createElement(StudyIntentControls, { attempt: { id, sessionId: id, courseId: "course" } })) })));
    const paragraph = host.querySelector("p")!;
    const range = document.createRange(); range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    const ask = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "我没懂")!;
    await act(async () => ask.click());
    expect(host.querySelector("[data-panel]")?.getAttribute("data-panel")).toBe("chat");
    expect(host.querySelector("p")).toBe(paragraph);
    expect(probe.context).toBe(binding.context);
    expect(probe.request).toMatchObject({ text: `请补充解释这段内容：\n${explanationActionPrompt("confused", "选中的原文")}` });
    const example = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="调整本次学习"] button')].find(button => button.textContent === "举个例子")!;
    await act(async () => example.click());
    expect(probe.context).toBe(binding.context);
    expect(probe.request).toMatchObject({ text: `请补充解释这段内容：\n${explanationActionPrompt("example")}` });
    expect(fetch.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
    expect(host.querySelector('a[href="/opening/courses/course"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges(); fetch.mockRestore(); }
});

it("owns a single top toolbar while the outline stays under the lesson title", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const binding: CurrentStudyContext = { isQuestion: false, context: { courseId: "course", label: "矩阵" } };
  const choose = vi.fn();
  try {
    await act(async () => root.render(createElement(LessonCompanionWorkspace, { binding, title: "矩阵", returnHref: "/opening/courses/course", progress: { current: 2, total: 5 }, outline: createElement("nav", { "aria-label": "课程目录" }, createElement("button", { onClick: choose }, "第二节")), children: createElement("textarea", { defaultValue: "原始作答" }) })));
    expect(probe.panels).toEqual(["chat", "notes", "materials"]);
    expect(probe.showToolbar).toBe(false);
    const header = host.querySelector("header")!;
    expect(header.textContent).toContain("单元 2 / 5");
    const outline = header.querySelector("details")!;
    expect(outline.open).toBe(false);
    expect(outline.querySelector('[aria-label="课程目录"]')).not.toBeNull();
    outline.open = true;
    await act(async () => outline.querySelector<HTMLButtonElement>("button")!.click());
    expect(choose).toHaveBeenCalledOnce();
    expect(outline.open).toBe(false);
    const answer = host.querySelector("textarea");
    expect(host.querySelector("[data-material-course]")).toBeNull();
    const tools = [...header.querySelectorAll("button")].find(button => button.textContent === "工具")!;
    await act(async () => tools.click());
    expect(host.querySelector("[data-panel]")?.getAttribute("data-panel")).toBe("chat");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-tool-tab="materials"]')!.click());
    expect(host.querySelector("[data-material-course]")?.getAttribute("data-material-course")).toBe("course");
    await act(async () => tools.click());
    expect(host.querySelector("[data-panel]")).toBeNull();
    expect(host.querySelector("textarea")).toBe(answer);
    await act(async () => header.querySelector<HTMLButtonElement>('[aria-label="专注学习"]')!.click());
    expect(probe.toggleFocus).toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
