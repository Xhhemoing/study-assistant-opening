// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { interactionMotionReduced, successfulInteractionHaptic } from "./haptics";

const vibrate = vi.fn();
beforeEach(() => {
  document.documentElement.dataset.motion = "full";
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  vi.stubGlobal("navigator", { vibrate });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vibrate.mockReset();
});
afterEach(() => { delete document.documentElement.dataset.motion; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("uses one short pulse and preserves the native receiver", () => {
  vibrate.mockImplementation(function (this: Navigator) { expect(this).toBe(navigator); return true; });
  successfulInteractionHaptic();
  expect(vibrate).toHaveBeenCalledExactlyOnceWith(8);
});
it.each(["user", "system"])("is silent for %s reduced motion", preference => {
  if (preference === "user") document.documentElement.dataset.motion = "reduce";
  else vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  expect(interactionMotionReduced()).toBe(true);
  successfulInteractionHaptic();
  expect(vibrate).not.toHaveBeenCalled();
});
it("does not pulse for a success received in a hidden document", () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  successfulInteractionHaptic();
  expect(vibrate).not.toHaveBeenCalled();
});
it("is a silent no-op when unsupported or rejected by the device", () => {
  vi.stubGlobal("navigator", {});
  expect(successfulInteractionHaptic).not.toThrow();
  vi.stubGlobal("navigator", { vibrate: () => { throw new Error("unsupported"); } });
  expect(successfulInteractionHaptic).not.toThrow();
});
it("does not require browser globals on the server", () => {
  vi.stubGlobal("window", undefined);
  expect(successfulInteractionHaptic).not.toThrow();
});
