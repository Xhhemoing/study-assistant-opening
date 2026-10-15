import { describe, expect, it } from "vitest";
import { summarizeTeachingBlockCoverage } from "./teaching-coverage";

describe("recorded teaching coverage", () => {
  const blocks = [
    { blockId: "a", position: 0, role: "teach", blockType: "text" },
    { blockId: "b", position: 1, role: "prompt", blockType: "prompt" },
    { blockId: "answer", position: 2, role: "answer_key", blockType: "answer_key" },
    { blockId: "c", position: 3, role: "teach", blockType: "text" },
  ];
  it("does not infer progress from rendered blocks or completion", () => {
    expect(summarizeTeachingBlockCoverage(blocks, {})).toEqual({ coveredBlockIds: [], skippedBlockIds: [] });
  });
  it("excludes skipped blocks, hidden answers and unknown checkpoint ids", () => {
    expect(summarizeTeachingBlockCoverage(blocks, { currentBlockId: "c", skippedBlockIds: ["b", "answer", "deleted"] })).toEqual({ coveredBlockIds: ["a", "c"], skippedBlockIds: ["b"] });
  });
});
