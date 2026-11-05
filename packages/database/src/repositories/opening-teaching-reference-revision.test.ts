import { describe, expect, it } from "vitest";
import type { TeachingBlockRef } from "@aistudy/contracts";
import { assertReferenceTextRevision } from "./opening-teaching-reference-revision";

const fields = ["text", "markdown", "answer", "solution"] as const;
const order: TeachingBlockRef[] = [
  { blockId: "question", blockType: "prompt", position: 0, role: "prompt" },
  { blockId: "reference", blockType: "answer_key", position: 1, role: "answer_key" },
];
function blocks(content: Record<string, unknown>, question = "计算 2+3"): Array<{ id: string; type: string; content: Record<string, unknown> }> {
  return [{ id: "question", type: "prompt", content: { text: question } },
    { id: "reference", type: "answer_key", content }];
}

describe("entire saved reference answer field validation", () => {
  it.each(fields)("rejects an incorrect %s even beside correct competing fields", field => {
    const before = blocks(Object.fromEntries(fields.map(key => [key, "5"])));
    const after = structuredClone(before);
    after[1]!.content[field] = "6";
    expect(() => assertReferenceTextRevision(order, before, after)).toThrow("reference answer does not match the question");
  });

  it("rejects correct text plus newly added incorrect solution", () => {
    expect(() => assertReferenceTextRevision(order, blocks({ text: "4" }), blocks({ text: "5", solution: "6" })))
      .toThrow("reference answer does not match the question");
  });

  it.each(fields)("accepts a correct revision in %s without inventing other fields", field => {
    const before = blocks({ [field]: "4" }), after = blocks({ [field]: "5" });
    expect(() => assertReferenceTextRevision(order, before, after)).not.toThrow();
    expect(after[1]!.content).toEqual({ [field]: "5" });
  });

  it("accepts correct equivalent multi-field answers without dropping any field", () => {
    const content = { text: "5", markdown: "5.0", answer: "10/2", solution: "2+3=5", citedChunkIds: [] };
    const before = blocks({ ...content, text: "4" }), after = blocks(content), snapshot = structuredClone(after);
    expect(() => assertReferenceTextRevision(order, before, after)).not.toThrow();
    expect(after).toEqual(snapshot);
  });

  it.each(fields)("allows unknown natural-language %s alongside correct arithmetic without claiming verification", field => {
    const before = blocks({ text: "4" });
    const after = blocks({ text: "5", [field]: "由题意可得结论，需要人工核对推理" });
    // Validation has no verified result: the adoption owner keeps needs_check.
    expect(assertReferenceTextRevision(order, before, after)).toBeUndefined();
  });

  it.each(fields)("rejects empty or non-text changed %s", field => {
    for (const value of [" ", 6, null, { text: "5" }]) {
      expect(() => assertReferenceTextRevision(order, blocks({ text: "4" }), blocks({ text: "5", [field]: value })))
        .toThrow("reference answer text must not be empty");
    }
  });

  it("does not let an unknown first field conceal a deterministically incorrect later answer", () => {
    expect(() => assertReferenceTextRevision(order, blocks({ text: "4" }), blocks({ text: "人工解释", solution: "6" })))
      .toThrow("reference answer does not match the question");
  });

  it("checks unchanged alternate fields when adopting a changed answer block", () => {
    expect(() => assertReferenceTextRevision(order, blocks({ text: "4", solution: "6" }), blocks({ text: "5", solution: "6" })))
      .toThrow("reference answer does not match the question");
  });
});
