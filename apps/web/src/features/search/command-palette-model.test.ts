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
    expect(filterPaletteCommands("高级").map((command) => command.id)).toEqual(["settings-advanced"]);
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

  it("keeps the Opening learning loop in the default palette and hides demoted entries", () => {
    const ids = PALETTE_COMMANDS.map((command) => command.id);
    expect(ids).toEqual(expect.arrayContaining([
      "today",
      "assistant",
      "courses",
      "cards",
      "opening-review",
      "connections",
      "search",
      "settings",
      "settings-advanced",
    ]));
    expect(ids).not.toContain("explore");
    expect(ids).not.toContain("new-exploration");
    expect(ids).not.toContain("marketplace");
    expect(ids).not.toContain("exams");
    expect(ids).not.toContain("new-goal");
    expect(ids).not.toContain("new-note");
    expect(ids).not.toContain("learn");
    expect(ids).not.toContain("library");
    expect(ids).not.toContain("goals");
    expect(ids).not.toContain("review");
    expect(ids).not.toContain("export");
    expect(PALETTE_COMMANDS.filter((command) => command.kind === "command")).toEqual([]);
    expect(SEARCH_DEBOUNCE_MS).toBe(150);
    expect(PALETTE_COMMANDS.filter((command) => command.kind === "page").map((command) => command.href)).toEqual(expect.arrayContaining([
      "/opening/today",
      "/opening/assistant",
      "/opening/courses",
      "/opening/cards",
      "/opening/review",
      "/opening/settings/connections",
      "/search",
      "/settings",
      "/settings/advanced",
    ]));
  });
});
