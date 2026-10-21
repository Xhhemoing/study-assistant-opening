// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCurrentStudyContext, useStudyAssistantContext, type CurrentStudyContext } from "./current-study-context";
import { openAssistantDrawer } from "./assistant-entry";
vi.mock("next/navigation", () => ({ usePathname: () => "/opening/today", useSearchParams: () => new URLSearchParams() }));
vi.mock("./assistant-session", () => ({ AssistantSession: () => <button data-free-send>自由提问发送</button> }));
import { AssistantDrawer } from "./assistant-drawer";

it("removes the open free dialog in the same commit as a real Today question registration", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({}, "", "/opening/today");
  const snapshots: boolean[] = [];
  function ObserveRegistration() {
    const binding = useCurrentStudyContext();
    useLayoutEffect(() => {
      if (binding) snapshots.push(Boolean(document.querySelector('[role="dialog"] [data-free-send]')));
    }, [binding]);
    return null;
  }
  function App({ context }: { context: CurrentStudyContext | null }) {
    useStudyAssistantContext(context);
    return <><AssistantDrawer /><ObserveRegistration /></>;
  }
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<App context={null} />));
    await act(async () => openAssistantDrawer());
    expect(document.querySelector('[role="dialog"] [data-free-send]')).not.toBeNull();
    const context: CurrentStudyContext = { context: { courseId: "11111111-1111-4111-8111-111111111111", label: "当前题" }, isQuestion: true, blockedReason: "请先保存原答" };
    await act(async () => root.render(<App context={context} />));
    expect(snapshots).toEqual([false]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
