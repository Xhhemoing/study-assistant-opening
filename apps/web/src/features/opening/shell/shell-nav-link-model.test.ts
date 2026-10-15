import { describe, expect, it } from "vitest";
import {
  SHELL_NAV_FALLBACK_MS,
  shouldScheduleShellNavFallback,
  shellNavPath,
  shellNavReached,
} from "./shell-nav-link-model";

/**
 * Repro (Hermes /opening/today, desktop sidebar):
 * 1. Open /opening/today with the teaching pane loaded.
 * 2. Click 课程 — soft nav usually succeeds.
 * 3. Return to /opening/today, then click 助理 or 笔记.
 * 4. Failure mode: the click target is the <a> (no overlay, no aria-disabled,
 *    no pointer-events-none, no dialog[open], no console error) but the URL
 *    stays on /opening/today and Playwright sees no framenavigated — next/link
 *    already preventDefault'd native navigation while the soft transition stalled.
 *
 * Automation of the stall is flaky (depends on concurrent Today updates), so
 * this suite locks the fallback decision instead of a full browser race.
 */
describe("shell nav fallback model", () => {
  it("exposes a short watchdog window for stalled soft navigations", () => {
    expect(SHELL_NAV_FALLBACK_MS).toBeGreaterThanOrEqual(500);
    expect(SHELL_NAV_FALLBACK_MS).toBeLessThanOrEqual(2_000);
  });

  it("strips query strings when comparing paths", () => {
    expect(shellNavPath("/opening/assistant?conversation=1")).toBe("/opening/assistant");
    expect(shellNavReached("/opening/library?tab=notes", "/opening/library")).toBe(true);
    expect(shellNavReached("/opening/assistant", "/opening/today")).toBe(false);
  });

  it("schedules a native fallback only for unmodified primary clicks that leave the page", () => {
    const base = {
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      button: 0,
      href: "/opening/assistant",
      pathname: "/opening/today",
    };
    expect(shouldScheduleShellNavFallback(base)).toBe(true);
    expect(shouldScheduleShellNavFallback({ ...base, pathname: "/opening/assistant" })).toBe(false);
    expect(shouldScheduleShellNavFallback({ ...base, defaultPrevented: true })).toBe(false);
    expect(shouldScheduleShellNavFallback({ ...base, metaKey: true })).toBe(false);
    expect(shouldScheduleShellNavFallback({ ...base, button: 1 })).toBe(false);
  });
});
