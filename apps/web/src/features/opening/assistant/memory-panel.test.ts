import { describe, expect, it } from "vitest";
import { formatMemoryTime, memorySourceSummary } from "./memory-panel";

describe("memory panel metadata", () => {
  it("summarizes source messages and materials without exposing internal identifiers", () => {
    expect(memorySourceSummary(
      ["turn-1", "turn-2"],
      ["source-1"],
    )).toBe("来源消息：2 条 · 关联资料：1 份");
  });

  it("does not claim material absence when the memory contract omits material ids", () => {
    expect(memorySourceSummary(["turn-1"])).toBe("来源消息：1 条");
  });

  it("falls back to the raw timestamp when a server timestamp is invalid", () => {
    expect(formatMemoryTime("not-a-date")).toBe("not-a-date");
  });
});
