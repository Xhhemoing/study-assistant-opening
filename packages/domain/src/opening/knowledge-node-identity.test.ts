import { describe, expect, it } from "vitest";
import type { KnowledgeNode, SourceChunk } from "@aistudy/contracts";
import { knowledgeNodeDefinition, sameKnowledgeNodeIdentity } from "./knowledge-node-identity";

const original: KnowledgeNode = { id: "node", courseId: "course", label: "Integral substitution", kind: "procedure",
  evidenceChunkIds: ["chunk-b", "chunk-a"], status: "supported" };

describe("knowledge node identity", () => {
  it("ignores evidence order and verification status, without guessing from nearby labels", () => {
    expect(sameKnowledgeNodeIdentity(original, { ...original, evidenceChunkIds: ["chunk-a", "chunk-b"], status: "needs_check" })).toBe(true);
    for (const change of [{ label: "Integral substitutions" }, { kind: "concept" as const }, { courseId: "other-course" },
      { evidenceChunkIds: ["replacement-version-chunk"] }]) {
      expect(sameKnowledgeNodeIdentity(original, { ...original, ...change })).toBe(false);
    }
  });
});

it("pins complete evidence and location while ignoring parser UUID and version churn", () => {
  const source: SourceChunk = { id: "old", sourceId: "source", sourceVersion: 1, page: 2, slideLabel: "第二章",
    startMs: null, endMs: null, text: "矩阵相乘： A B ≠ B A\n当 B 为单位矩阵时例外。", imageObjectKey: null };
  const node = { ...original, evidenceChunkIds: [source.id] };
  const definition = knowledgeNodeDefinition(node, [source]);
  const newNode = { ...node, evidenceChunkIds: ["new-parser-id"] };
  const reparsed = { ...source, id: "new-parser-id", sourceVersion: 2, text: source.text.replace("\n", "\r\n") };
  expect(knowledgeNodeDefinition(newNode, [reparsed])).toBe(definition);
  for (const change of [{ text: source.text.replace("≠", "=") }, { text: "矩阵相乘： A B ≠ B A" },
    { page: 3 }, { sourceId: "other-source" }, { slideLabel: "第三章" }]) {
    expect(knowledgeNodeDefinition(node, [{ ...source, ...change }])).not.toBe(definition);
  }
  expect(knowledgeNodeDefinition(node, [])).toBeNull();
  expect(knowledgeNodeDefinition(node, [{ ...source, text: "x²" }]))
    .not.toBe(knowledgeNodeDefinition(node, [{ ...source, text: "x2" }]));
  expect(knowledgeNodeDefinition(node, [{ ...source, text: "if x:\n  y = 2\nz = 3" }]))
    .not.toBe(knowledgeNodeDefinition(node, [{ ...source, text: "if x:\n  y = 2\n  z = 3" }]));
});
