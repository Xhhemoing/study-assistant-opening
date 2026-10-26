// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  hydrated: true, update: vi.fn(),
  preferences: { theme: "system", readingFont: "serif", motion: "system", diagnostics: false },
}));
vi.mock("./appearance-preferences", () => ({ useAppearancePreferences: () => ({ preferences: state.preferences, hydrated: state.hydrated, persistenceError: false, updatePreferences: state.update }) }));
vi.mock("../../settings/ui-style-settings", () => ({ UiStyleSettings: () => null }));
import { AppearanceSettings } from "./appearance-settings";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.hydrated = true; state.update.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("keeps diagnostics collapsed until the learner opens advanced settings and preserves its toggle", async () => {
  await act(async () => root.render(<AppearanceSettings />));
  const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const advanced = checkbox.closest("details");
  expect(advanced).not.toBeNull();
  expect(advanced?.open).toBe(false);
  expect(advanced?.querySelector("summary")?.textContent).toBe("高级设置");
  await act(async () => { advanced!.open = true; checkbox.click(); });
  expect(state.update).toHaveBeenCalledWith({ diagnostics: true });
});
it("keeps the diagnostic preference disabled until browser preferences are ready", async () => {
  state.hydrated = false;
  await act(async () => root.render(<AppearanceSettings />));
  const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.disabled).toBe(true);
  await act(async () => checkbox.click());
  expect(state.update).not.toHaveBeenCalled();
});
