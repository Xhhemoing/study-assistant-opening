// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ usageReady: false }));
vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: "a" }));
vi.mock("./ai-settings-panel", () => ({ AiSettingsPanel: () => <details data-own-models><summary>使用自己的模型</summary><div id="quick-model-setup">配置</div>{mocks.usageReady ? <div id="daily-budget">用量</div> : null}</details> }));
vi.mock("../planning/loop-metrics-panel", () => ({ LoopMetricsPanel: () => null }));
vi.mock("../planning/plan-feedback-panel", () => ({ PlanFeedbackPanel: () => null }));
vi.mock("../guidance-settings/guidance-mode-picker", () => ({ GuidanceModePicker: () => null }));
vi.mock("./settings-shared", async importOriginal => ({ ...await importOriginal<typeof import("./settings-shared")>(), fetchWorkspacePreferences: async () => ({ defaultEntry: "learn" }) }));
import { AdvancedSettingsView } from "./advanced-settings-view";

let host: HTMLDivElement, root: Root;
const scroll = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState(null, "", "/opening/settings/ai");
  mocks.usageReady = false; scroll.mockClear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"); vi.restoreAllMocks(); });
const render = async () => { await act(async () => root.render(<AdvancedSettingsView basePath="/opening/settings" embedded />)); };
const target = (id: string) => host.querySelector<HTMLElement>(`#${id}`)!;

it.each(["export", "developer"])("reveals the real legacy #%s destination on entry", async id => {
  window.history.replaceState(null, "", `/opening/settings/ai#${id}`);
  await render();
  expect(target(id)).not.toBeNull();
  expect(target(id).closest("details")?.open).toBe(true);
  expect(scroll).toHaveBeenCalled();
});

it("keeps folds closed without a requested destination", async () => {
  await render();
  expect([...host.querySelectorAll("details")].every(item => !item.open)).toBe(true);
  expect(scroll).not.toHaveBeenCalled();
});

it("reveals an existing custom-model destination on hash navigation", async () => {
  await render();
  await act(async () => {
    window.history.replaceState(null, "", "/opening/settings/ai#quick-model-setup");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(target("quick-model-setup").closest("details")?.open).toBe(true);
});

it("waits for a late usage destination then leaves a manual close alone", async () => {
  window.history.replaceState(null, "", "/opening/settings/ai#daily-budget");
  await render();
  expect(scroll).not.toHaveBeenCalled();
  mocks.usageReady = true;
  await render();
  const details = target("daily-budget").closest("details")!;
  expect(details.open).toBe(true);
  const count = scroll.mock.calls.length;
  details.open = false;
  await act(async () => { details.append(document.createElement("span")); });
  expect(details.open).toBe(false);
  expect(scroll).toHaveBeenCalledTimes(count);
});

it("removes pending observers and hash listeners on unmount", async () => {
  window.history.replaceState(null, "", "/opening/settings/ai#daily-budget");
  await render();
  await act(async () => root.render(null));
  host.innerHTML = '<details><summary>other</summary><div id="daily-budget"></div></details>';
  await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  expect(scroll).not.toHaveBeenCalled();
  expect(host.querySelector("details")!.open).toBe(false);
});
