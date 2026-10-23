import { describe, expect, it } from "vitest";
import { MAX_SPLIT_PANES, toggleSplitPane, visibleSplitPanes } from "./split-view";
import { NAV_WIDTH_DEFAULT, NAV_WIDTH_MAX, NAV_WIDTH_MIN, clampNavWidth, normalizeLayoutPref } from "../shell/use-layout-pref";

describe("split panes", () => {
  it("opens at most two panes, replacing the oldest", () => {
    expect(toggleSplitPane([], "assistant")).toEqual(["assistant"]);
    expect(toggleSplitPane(["assistant"], "notes")).toEqual(["assistant", "notes"]);
    expect(toggleSplitPane(["assistant", "notes"], "sources")).toEqual(["notes", "sources"]);
    expect(toggleSplitPane(["assistant", "notes"], "assistant")).toEqual(["notes"]);
    expect(MAX_SPLIT_PANES).toBe(2);
  });
  it("only shows panes the page provides", () => {
    const spec = { label: "x", icon: null, render: () => null };
    expect(visibleSplitPanes(["assistant", "sources"], { assistant: spec })).toEqual(["assistant"]);
  });
});

describe("layout preference", () => {
  it("clamps nav width and repairs stored values", () => {
    expect(clampNavWidth(100)).toBe(NAV_WIDTH_MIN);
    expect(clampNavWidth(999)).toBe(NAV_WIDTH_MAX);
    expect(clampNavWidth(Number.NaN)).toBe(NAV_WIDTH_DEFAULT);
    const pref = normalizeLayoutPref({ skin: "neon" as never, navWidth: 9000, split: ["assistant", "assistant", "bogus" as never, "notes", "sources"], splitLayouts: { ok: { main: 70, assistant: 30 }, bad: { main: 400 } } });
    expect(pref.skin).toBe("frost");
    expect(pref.navWidth).toBe(NAV_WIDTH_MAX);
    expect(pref.split).toEqual(["assistant", "notes"]);
    expect(Object.keys(pref.splitLayouts)).toEqual(["ok"]);
  });
  it("defaults to light glass and the narrower nav", () => {
    const pref = normalizeLayoutPref({});
    expect(pref.skin).toBe("frost");
    expect(pref.navWidth).toBe(208);
    expect(pref.split).toEqual([]);
  });
});
