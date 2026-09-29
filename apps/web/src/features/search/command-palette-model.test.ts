import { describe, expect, it } from "vitest";
import {
  PALETTE_COMMANDS,
  SEARCH_DEBOUNCE_MS,
  filterPaletteCommands,
  getPaletteKeyAction,
  getNextPaletteIndex,
} from "./command-palette-model";

describe("command palette keyboard model", () => {
  it("filters pages by label, description, or route without inventing content hits", () => {
    expect(filterPaletteCommands("备份").map((command) => command.id)).toEqual(["export"]);
    expect(filterPaletteCommands("/OPENING/ASSISTANT").map((command) => command.id)).toEqual(["assistant"]);
    expect(filterPaletteCommands("不存在的内容关键词")).toEqual([]);
    expect(filterPaletteCommands("  ")).toHaveLength(PALETTE_COMMANDS.length);
  });
  it("maps navigation, selection, and dismissal keys", () => {
    expect(getPaletteKeyAction("ArrowDown")).toBe("next");
    expect(getPaletteKeyAction("ArrowUp")).toBe("previous");
    expect(getPaletteKeyAction("Enter")).toBe("select");
    expect(getPaletteKeyAction("Escape")).toBe("close");
    expect(getPaletteKeyAction("a")).toBe("none");
    expect(getPaletteKeyAction("Enter", true)).toBe("none");
  });

  it("wraps the active option while navigating", () => {
    expect(getNextPaletteIndex(0, "previous", 3)).toBe(2);
    expect(getNextPaletteIndex(2, "next", 3)).toBe(0);
    expect(getNextPaletteIndex(1, "next", 0)).toBe(-1);
  });

  it("keeps creation commands alongside searchable page navigation", () => {
    expect(PALETTE_COMMANDS.filter((command) => command.kind === "command").map((command) => command.id)).toEqual([
      "new-note",
      "new-exploration",
      "new-goal",
    ]);
    expect(SEARCH_DEBOUNCE_MS).toBe(150);
    expect(PALETTE_COMMANDS.filter((command) => command.kind === "page").map((command) => command.href)).toEqual(expect.arrayContaining(["/opening/today", "/opening/assistant", "/learn", "/explore", "/library", "/opening/courses", "/opening/review", "/learn/goals", "/learn/exams", "/learn/marketplace", "/learn/review", "/search", "/settings", "/settings/export"]));
  });
});
