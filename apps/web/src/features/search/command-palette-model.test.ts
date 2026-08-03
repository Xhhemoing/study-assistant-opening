import { describe, expect, it } from "vitest";
import {
  PALETTE_COMMANDS,
  SEARCH_DEBOUNCE_MS,
  getPaletteKeyAction,
  getNextPaletteIndex,
} from "./command-palette-model";

describe("command palette keyboard model", () => {
  it("maps navigation, selection, and dismissal keys", () => {
    expect(getPaletteKeyAction("ArrowDown")).toBe("next");
    expect(getPaletteKeyAction("ArrowUp")).toBe("previous");
    expect(getPaletteKeyAction("Enter")).toBe("select");
    expect(getPaletteKeyAction("Escape")).toBe("close");
    expect(getPaletteKeyAction("a")).toBe("none");
  });

  it("wraps the active option while navigating", () => {
    expect(getNextPaletteIndex(0, "previous", 3)).toBe(2);
    expect(getNextPaletteIndex(2, "next", 3)).toBe(0);
    expect(getNextPaletteIndex(1, "next", 0)).toBe(-1);
  });

  it("keeps the three first-class creation commands and search debounce", () => {
    expect(PALETTE_COMMANDS.map((command) => command.id)).toEqual([
      "new-note",
      "new-exploration",
      "new-goal",
    ]);
    expect(SEARCH_DEBOUNCE_MS).toBe(150);
  });
});
