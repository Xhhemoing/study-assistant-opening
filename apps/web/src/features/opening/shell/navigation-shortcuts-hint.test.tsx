// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NavigationShortcutsHint } from "./navigation-shortcuts-hint";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); localStorage.clear(); });
it("shows shortcuts once and respects an explicit dismissal on remount", async () => {
  await act(async () => root.render(<NavigationShortcutsHint />));
  expect(host.textContent).toContain("Ctrl / ⌘ K");
  expect(host.textContent).toContain("Ctrl / ⌘ J");
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector('[role="note"]')).toBeNull();
  await act(async () => root.unmount()); root = createRoot(host);
  await act(async () => root.render(<NavigationShortcutsHint />));
  expect(host.querySelector('[role="note"]')).toBeNull();
});
it("can dismiss the hint during this visit when local preferences are unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  await act(async () => root.render(<NavigationShortcutsHint />));
  expect(host.querySelector('[role="note"]')).not.toBeNull();
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector('[role="note"]')).toBeNull();
});
