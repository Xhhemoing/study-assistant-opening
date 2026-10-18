import { describe, expect, it, vi } from "vitest";
import type { ClientInitBlock } from "./component-catalog";
import { buildTeachingStudyUnits, saveTeachingUnitPosition, teachingStudyUnitText, teachingUnitForBlock } from "./study-unit-focus";

const block = (blockId: string, position: number, blockType = "text", role: ClientInitBlock["role"] = "teach"): ClientInitBlock => ({ blockId, position, blockType, role, content: { text: blockId } });

describe("complete teaching units", () => {
  it("keeps explanation, formula, full derivation and diagram together before an independent question", () => {
    const blocks = [block("intro", 0), block("formula", 1, "math"), block("derivation", 2, "step"), block("diagram", 3, "matrix_transform"), block("question", 4, "question", "prompt"), { ...block("answer", 5, "answer_key", "answer_key"), content: null }, block("evidence", 6, "evidence")];
    const units = buildTeachingStudyUnits(blocks);
    expect(units.map(unit => unit.blocks.map(item => item.blockId))).toEqual([["intro", "formula", "derivation", "diagram"], ["question", "answer", "evidence"]]);
    expect(units[1]?.questionBlockId).toBe("question");
    expect(teachingUnitForBlock(units, "derivation")?.id).toBe("intro");
    expect(teachingUnitForBlock(units, "answer")?.id).toBe("question");
  });
  it("keeps separate questions and following explanations individually addressable", () => {
    const units = buildTeachingStudyUnits([block("question-1", 0, "question", "prompt"), block("draft", 1, "draft"), block("question-2", 2, "question", "prompt"), block("next-concept", 3), block("next-math", 4, "math")]);
    expect(units.map(unit => unit.blocks.map(item => item.blockId))).toEqual([["question-1", "draft"], ["question-2"], ["next-concept", "next-math"]]);
  });
  it("uses an actual heading for outline labels without changing block identity", () => {
    const units = buildTeachingStudyUnits([{ ...block("intro", 2), content: { text: "## 矩阵如何改变向量\n完整讲解" } }, block("first", 1)]);
    expect(units[0]?.blocks.map(item => item.blockId)).toEqual(["first", "intro"]);
    expect(teachingUnitForBlock([], null)).toBeNull();
    expect(buildTeachingStudyUnits([{ ...block("intro", 0), content: { text: "## 矩阵如何改变向量\n完整讲解" } }])[0]?.title).toBe("矩阵如何改变向量");
  });
  it("passes visible complete content and formulas to contextual tools while excluding answers and personal drafts", () => {
    const unit = buildTeachingStudyUnits([
      { ...block("question", 0, "question", "prompt"), content: { text: "解释矩阵变换" } },
      { ...block("answer", 1, "answer_key", "answer_key"), content: { text: "SECRET ANSWER" } },
      { ...block("draft", 2, "draft"), content: { text: "UNSENT ANSWER" } },
    ])[0] ?? null;
    expect(teachingStudyUnitText(unit)).toBe("解释矩阵变换");
    expect(teachingStudyUnitText(buildTeachingStudyUnits([{ ...block("math", 0, "math"), content: { latex: "A v = w" } }, { ...block("steps", 1, "step"), content: { steps: ["先观察", { text: "再推导" }] } }])[0] ?? null)).toBe("A v = w\n\n先观察\n\n再推导");
    expect(teachingStudyUnitText(buildTeachingStudyUnits([{ ...block("long", 0), content: { text: "长".repeat(5000) } }])[0] ?? null)).toHaveLength(4000);
  });
});

describe("unit position persistence", () => {
  it("writes only the existing cursor with its version and preserves the server checkpoint", async () => {
    const checkpoint = { currentBlockId: "question", drafts: [{ blockId: "question", draftText: "尚未提交" }], skippedBlockIds: [] };
    const postTeachingCheckpoint = vi.fn(async () => ({ ok: true as const, contentVersion: 3, checkpointJson: checkpoint }));
    expect(await saveTeachingUnitPosition({ postTeachingCheckpoint }, "activity", 3, "question")).toEqual({ ok: true, contentVersion: 3, checkpointJson: checkpoint });
    expect(postTeachingCheckpoint).toHaveBeenCalledWith("activity", { expectedVersion: 3, currentBlockId: "question" });
  });
  it("surfaces conflicts without moving or overwriting drafts", async () => {
    const postTeachingCheckpoint = vi.fn(async () => ({ ok: false as const, mismatch: "draft_anchor_lost" as const, lostBlockIds: ["question"] }));
    await expect(saveTeachingUnitPosition({ postTeachingCheckpoint }, "activity", 3, "question")).rejects.toThrow("原草稿仍保留");
    expect(postTeachingCheckpoint).toHaveBeenCalledOnce();
  });
});
