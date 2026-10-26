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
