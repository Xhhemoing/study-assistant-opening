import { describe, expect, it } from "vitest";
import type { TeachingBlockRef } from "@aistudy/contracts";
import { assertReferenceTextRevision } from "./opening-teaching-reference-revision";

type Block = { id: string; type: string; content: Record<string, unknown> };
function fixture() {
  const order: TeachingBlockRef[] = [
    { blockId: "q1", blockType: "prompt", position: 0, role: "prompt" },
    { blockId: "a1", blockType: "answer_key", position: 1, role: "answer_key" },
    { blockId: "q2", blockType: "question", position: 2, role: "prompt" },
    { blockId: "a2", blockType: "solution", position: 3, role: "answer_key" },
  ];
  const before: Block[] = [
    { id: "q1", type: "prompt", content: { text: "计算 2+3", interaction: { kind: "numeric" }, citedChunkIds: ["chunk-1"] } },
    { id: "a1", type: "answer_key", content: { answer: "4", hidden: true, hints: { direction: "先看加法" } } },
    { id: "q2", type: "question", content: { text: "计算 4+5" } },
    { id: "a2", type: "solution", content: { solution: "8", hidden: true } },
    { id: "context", type: "paragraph", content: { text: "仅考虑整数", figure: "figure-1" } },
    { id: "unbound", type: "answer_key", content: { answer: "未绑定参考" } },
  ];
  const after = structuredClone(before); after[1]!.content.answer = "5"; after[3]!.content.solution = "9";
  return { order, before, after };
}

describe("reference-only publication must preserve the entire saved teaching context (pure)", () => {
  it.each([
    ["prompt text", 0, "text", "计算 2+4"],
    ["prompt condition", 0, "conditions", "只考虑正数"],
    ["prompt interaction", 0, "interaction", { kind: "choice", options: ["4", "5"] }],
    ["prompt unit", 0, "interaction", { kind: "numeric", unit: "米" }],
    ["prompt citation", 0, "citedChunkIds", ["chunk-2"]],
    ["prompt rewrite marker", 0, "rewriteOf", { contentVersion: 1 }],
    ["other prompt", 2, "text", "计算 4+6"],
    ["context condition", 4, "text", "仅考虑实数"],
    ["context figure", 4, "figure", "figure-2"],
    ["unbound answer", 5, "answer", "新未绑定参考"],
    ["answer hidden flag", 1, "hidden", false],
    ["answer hints", 1, "hints", { direction: "直接看答案" }],
    ["other answer metadata", 3, "hidden", false],
  ] as const)("rejects changed %s despite otherwise valid answer text", (_label, index, key, value) => {
    const { order, before, after } = fixture();
    after[index]!.content[key] = value;
    const snapshot = structuredClone({ order, before, after });
    expect(() => assertReferenceTextRevision(order, before, after)).toThrow(/only .*reference answer text may change/);
    expect({ order, before, after }).toEqual(snapshot);
  });

  it.each(["id", "type"] as const)("does not let an allowed answer text edit conceal changed answer %s", field => {
    const { order, before, after } = fixture(); after[1]![field] = "other";
    expect(() => assertReferenceTextRevision(order, before, after)).toThrow();
  });

  it.each(["insert", "delete", "reorder"] as const)("rejects saved block %s without rewriting history", kind => {
    const { order, before, after } = fixture();
    if (kind === "insert") after.push({ id: "new", type: "paragraph", content: { text: "额外条件" } });
    if (kind === "delete") after.pop();
    if (kind === "reorder") [after[4], after[5]] = [after[5]!, after[4]!];
    expect(() => assertReferenceTextRevision(order, before, after)).toThrow();
  });

  it.each(["role", "blockType", "notAdjacent", "unboundOnly"] as const)("does not infer reference binding from physical proximity: %s", kind => {
    const { order, before, after } = fixture();
    if (kind === "role") { order[0]!.role = "answer_key"; }
    if (kind === "blockType") { order[0]!.role = "teach"; order[0]!.blockType = "text"; }
    if (kind === "notAdjacent") { order[1]!.position = 99; }
    if (kind === "unboundOnly") { after[1]!.content.answer = "4"; after[3]!.content.solution = "8"; after[5]!.content.answer = "改了未绑定答案"; }
    expect(() => assertReferenceTextRevision(order, before, after)).toThrow();
  });

  it.each([false, true])("permits both bound references, including stable duplicate positions=%s", duplicatePositions => {
    const { order, before, after } = fixture();
    if (duplicatePositions) order.forEach(ref => { ref.position = 0; });
    const snapshot = structuredClone({ order, before, after });
    expect(assertReferenceTextRevision(order, before, after)).toBeUndefined();
    expect({ order, before, after }).toEqual(snapshot);
  });

  it.each([0, 1])("rejects one wrong answer even when the other reference is correct (wrong=%s)", wrong => {
    const { order, before, after } = fixture();
    if (wrong === 0) after[1]!.content.answer = "6"; else after[3]!.content.solution = "10";
    expect(() => assertReferenceTextRevision(order, before, after)).toThrow("reference answer does not match the question");
  });

  it("does not mistake an unchanged reference for a fresh publication", () => {
    const { order, before } = fixture();
    expect(() => assertReferenceTextRevision(order, before, structuredClone(before))).toThrow("reference answer text has not changed");
  });
});
