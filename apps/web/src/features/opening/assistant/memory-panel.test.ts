import { describe, expect, it } from "vitest";
import { formatMemoryTime, memorySourceSummary } from "./memory-panel";

describe("memory panel metadata", () => {
  it("keeps source turn and material identifiers visible", () => {
    expect(memorySourceSummary(
      ["turn-1", "turn-2"],
      ["source-1"],
    )).toBe("来源轮次：turn-1、turn-2 · 关联材料：source-1");
  });

  it("does not claim material absence when the memory contract omits material ids", () => {
    expect(memorySourceSummary(["turn-1"])).toBe("来源轮次：turn-1");
  });

  it("falls back to the raw timestamp when a server timestamp is invalid", () => {
    expect(formatMemoryTime("not-a-date")).toBe("not-a-date");
  });
});
