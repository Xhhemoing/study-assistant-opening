import { expect, it } from "vitest";
import { knowledgeNodeDefinition } from "@aistudy/domain";
import { reconcileExtractedSnapshot, retainKnowledgeIdentities, type AuthorizedChunk } from "./build-course-knowledge";
import { KNOWLEDGE_BATCH_CHARACTERS, knowledgeExtractionBatches, mergeKnowledgeBatches } from "./knowledge-extraction-batches";

const chunk = (id: string, text: string, sourceId = "source"): AuthorizedChunk => ({ id, text, sourceId, courseId: "course",
  sourceVersion: 1, page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null });
const graph = (id: string) => ({ nodes: [{ label: "定义", kind: "concept" as const, evidenceChunkIds: [id] }], edges: [] });

it("starts batches at chapter and source boundaries and never truncates oversized chunks", () => {
  const input = [chunk("one", "# 第一章\n概念"), chunk("two", "应用"), chunk("three", "# 第二章\n程序"),
    chunk("four", "x".repeat(KNOWLEDGE_BATCH_CHARACTERS + 123), "other")];
  const batches = knowledgeExtractionBatches(input);
  expect(batches.map(batch => batch.chapter)).toEqual(["# 第一章", "# 第二章", null, null]);
  expect(batches.flatMap(batch => batch.chunks).map(part => part.text).join("")).toBe(input.map(part => part.text).join(""));
  expect(batches.every(batch => batch.chunks.reduce((sum, part) => sum + part.text.length, 0) <= KNOWLEDGE_BATCH_CHARACTERS)).toBe(true);
});

it("does not split supplementary mathematical symbols at the character boundary", () => {
  const text = "x".repeat(KNOWLEDGE_BATCH_CHARACTERS - 1) + "𝑥tail";
  const batches = knowledgeExtractionBatches([chunk("one", text)]);
  expect(batches).toHaveLength(2);
  expect(batches[0]!.chunks[0]!.text).toHaveLength(KNOWLEDGE_BATCH_CHARACTERS - 1);
  expect(batches[1]!.chunks[0]!.text).toBe("𝑥tail");
  expect(batches.flatMap(batch => batch.chunks).map(part => part.text).join("")).toBe(text);
});

it("keeps identical labels from different source definitions separate and deduplicates repeated evidence", () => {
  const first = chunk("one", "向量空间的定义"), second = chunk("two", "概率空间的定义", "other");
  const a = reconcileExtractedSnapshot("course", 1, graph(first.id), [first]);
  const repeated = reconcileExtractedSnapshot("course", 1, graph(first.id), [first]);
  const b = reconcileExtractedSnapshot("course", 1, graph(second.id), [second]);
  const merged = mergeKnowledgeBatches("course", 1, [a, repeated, b], [first, second]);
  expect(merged.nodes).toHaveLength(2);
  expect(merged.nodes.map(node => node.evidenceChunkIds)).toEqual([[first.id], [second.id]]);
  expect(mergeKnowledgeBatches("course", 1, [a, repeated], [first], new Set([first.id])).nodes).toHaveLength(2);
});

it("reuses a node after same-content reparsing but gives a changed definition a new identity", () => {
  const original = chunk("old", "当且仅当 det(A) ≠ 0 时 A 可逆");
  const previous = reconcileExtractedSnapshot("course", 1, graph(original.id), [original]);
  const id = previous.nodes[0]!.id;
  const definitions = { [id]: knowledgeNodeDefinition(previous.nodes[0]!, [original])! };
  const reparsed = { ...original, id: "new", sourceVersion: 2 };
  const next = reconcileExtractedSnapshot("course", 2, graph(reparsed.id), [reparsed]);
  expect(retainKnowledgeIdentities(next, [reparsed], previous, [id], definitions).nodes[0]!.id).toBe(id);
  const changed = { ...reparsed, text: "当且仅当 det(A) = 0 时 A 可逆" };
  expect(retainKnowledgeIdentities(next, [changed], previous, [id], definitions).nodes[0]!.id).not.toBe(id);
});

it("does not reuse an old skill for a reparse that flattens mathematical notation", () => {
  const original = chunk("old", "f(x) = x² + x₁");
  const previous = reconcileExtractedSnapshot("course", 1, graph(original.id), [original]);
  const id = previous.nodes[0]!.id;
  const definitions = { [id]: knowledgeNodeDefinition(previous.nodes[0]!, [original])! };
  const changed = { ...original, id: "new", text: "f(x) = x2 + x1" };
  const next = reconcileExtractedSnapshot("course", 2, graph(changed.id), [changed]);
  expect(retainKnowledgeIdentities(next, [changed], previous, [id], definitions).nodes[0]!.id).not.toBe(id);
});

it("does not erase an ambiguous split when chapter graphs are merged", () => {
  const source = chunk("one", "同一段材料介绍两个不同定义");
  const original = reconcileExtractedSnapshot("course", 1, graph(source.id), [source]);
  const split = reconcileExtractedSnapshot("course", 2, { nodes: [...graph(source.id).nodes, ...graph(source.id).nodes],
    edges: [{ fromLabel: "定义", toLabel: "定义", kind: "contains", evidenceChunkIds: [source.id] }] }, [source]);
  const merged = mergeKnowledgeBatches("course", 2, [split], [source]);
  expect(merged.nodes).toHaveLength(2);
  expect(merged.edges).toEqual([]);
  expect(retainKnowledgeIdentities(merged, [source], original).nodes.some(node => node.id === original.nodes[0]!.id)).toBe(false);
});
