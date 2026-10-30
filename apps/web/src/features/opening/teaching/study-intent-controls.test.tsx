// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { StudyIntentControls } from "./study-intent-controls";
import { explanationActionPrompt } from "./explanation-actions";
import { LessonSelectionAskContext } from "./selection-ask";

it("offers the same four explanation actions and prepares an example in the lesson's existing companion", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const id = "11111111-1111-4111-8111-111111111111";
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ event: null }));
  const ask = vi.fn();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<LessonSelectionAskContext.Provider value={ask}><StudyIntentControls attempt={{ id, sessionId: id, courseId: id }} /></LessonSelectionAskContext.Provider>));
    const actions = host.querySelector('[data-explanation-actions="true"]')!;
    expect([...actions.querySelectorAll("button")].map(button => button.textContent)).toEqual(["我没懂", "举个例子", "讲快点", "讲细点"]);
    const trigger = [...host.querySelectorAll("button")].find(button => button.textContent === "讲解帮助")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => [...actions.querySelectorAll("button")].find(button => button.textContent === "举个例子")!.click());
    expect(ask).toHaveBeenCalledWith(explanationActionPrompt("example"));
    expect(fetch.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); fetch.mockRestore(); }
});

it("does not replay a historical event over the current durable session intent", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const id = "11111111-1111-4111-8111-111111111111";
  const currentIntent = { purpose: "challenge" as const, timeBudgetMinutes: 25, language: "zh" as const, pace: "fast" as const, continuous: true, selfReportedFatigue: "unknown" as const };
  const historicalIntent = { ...currentIntent, purpose: "self_study" as const, pace: "normal" as const };
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ event: { id, sessionId: id, activityId: id, attemptId: null, version: 1, change: { kind: "preference", intent: historicalIntent }, intent: historicalIntent, signals: [], action: "continue", createdAt: "2026-10-30T00:00:00.000Z" } }));
  const applied = vi.fn(); const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<StudyIntentControls attempt={{ sessionId: id, courseId: id }} currentIntent={currentIntent} onApplied={applied} />));
    await act(async () => { await Promise.resolve(); });
    expect(applied).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); fetch.mockRestore(); }
});
