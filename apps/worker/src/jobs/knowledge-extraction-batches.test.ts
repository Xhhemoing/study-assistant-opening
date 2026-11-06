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

it("marks independent complete same-name definitions as candidates without changing identity, evidence or edges", () => {
  const a = chunk("definition-a", "f(x) = x² + x₁", "book"),
    b = { ...chunk("definition-b", "f(x) = x² - x₁", "lecture"), sourceVersion: 4, page: 19 };
  const first = reconcileExtractedSnapshot("course", 1, graph(a.id), [a]);
  const second = reconcileExtractedSnapshot("course", 1, graph(b.id), [b]);
  first.nodes[0]!.label = "cafe\u0301";
  second.nodes[0]!.label = "café";
  first.edges.push({ from: first.nodes[0]!.id, to: first.nodes[0]!.id, kind: "contains",
    evidenceChunkIds: [a.id], status: "supported" });
  const before = structuredClone([first, second]);
  expect(before.map(snapshot => snapshot.nodes[0]!.status)).toEqual(["supported", "supported"]);
  const merged = mergeKnowledgeBatches("course", 1, [first, second], [a, b]);
  expect(merged.nodes).toEqual(before.flatMap(snapshot => snapshot.nodes.map(node => ({ ...node, status: "needs_check" }))));
  expect(merged.edges).toEqual(first.edges);
  expect([first, second]).toEqual(before);
});

it("still unions exact complete cross-source definitions as supported and never upgrades needs_check", () => {
  const a = chunk("a", "cafe\u0301\r\nx² + x₁", "book"), b = chunk("b", "café\nx² + x₁", "lecture");
  const first = reconcileExtractedSnapshot("course", 1, graph(a.id), [a]);
  const second = reconcileExtractedSnapshot("course", 1, graph(b.id), [b]);
  expect(mergeKnowledgeBatches("course", 1, [first, second], [a, b]).nodes)
    .toEqual([{ ...first.nodes[0], evidenceChunkIds: [a.id, b.id], status: "supported" }]);
  first.nodes[0]!.status = "needs_check";
  expect(mergeKnowledgeBatches("course", 1, [first, second], [a, b]).nodes[0]!.status).toBe("needs_check");
});

it.each([
  { sourceId: "book" }, { courseId: "other-course" }, { text: "" },
  { imageObjectKey: "figure" }, { startMs: 0, endMs: 100 },
])("does not add cross-source candidates when provenance or complete text is insufficient: %j", overrides => {
  const a = chunk("a", "first complete definition", "book"),
    b = { ...chunk("b", "different definition", "lecture"), ...overrides };
  const first = reconcileExtractedSnapshot("course", 1, graph(a.id), [a]);
  const second = reconcileExtractedSnapshot("course", 1, graph(b.id), [b]);
  expect(mergeKnowledgeBatches("course", 1, [first, second], [a, b]).nodes).toEqual([...first.nodes, ...second.nodes]);
});

it.each(["x2 + x₁", "x² + x1", "x² - x₁", "x² + x₁ "])("keeps a literal difference as a candidate rather than normalizing it away: %s", text => {
  const a = chunk("a", "x² + x₁", "book"), b = chunk("b", text, "lecture");
  const first = reconcileExtractedSnapshot("course", 1, graph(a.id), [a]);
  const second = reconcileExtractedSnapshot("course", 1, graph(b.id), [b]);
  first.nodes[0]!.status = "needs_check";
  expect(mergeKnowledgeBatches("course", 1, [first, second], [a, b]).nodes)
    .toEqual([{ ...first.nodes[0], status: "needs_check" }, { ...second.nodes[0], status: "needs_check" }]);
});

it("does not add candidates across labels, kinds, courses, or sliced parser evidence", () => {
  const a = chunk("a", "first definition", "book"), b = chunk("b", "second definition", "lecture");
  const first = reconcileExtractedSnapshot("course", 1, graph(a.id), [a]);
  const second = reconcileExtractedSnapshot("course", 1, graph(b.id), [b]);
  for (const change of [{ label: "different" }, { kind: "procedure" as const }, { courseId: "other-course" }]) {
    const changed = { ...second, nodes: second.nodes.map(node => ({ ...node, ...change })) };
    expect(mergeKnowledgeBatches("course", 1, [first, changed], [a, b]).nodes).toEqual([...first.nodes, ...changed.nodes]);
  }
  expect(mergeKnowledgeBatches("course", 1, [first, second], [a, b], new Set([b.id])).nodes)
    .toEqual([...first.nodes, ...second.nodes]);
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


it("unions complete exact definitions across source versions and pages with NFC/CRLF only", () => {
  const a = chunk("a", "cafe\u0301\r\nx² + x₁"), b = { ...chunk("b", "café\nx² + x₁", "lecture"), sourceVersion: 7, page: 42 };
  const first = reconcileExtractedSnapshot("course", 1, graph(a.id), [a]);
  const second = reconcileExtractedSnapshot("course", 1, graph(b.id), [b]);
  second.nodes[0]!.status = "needs_check";
  const merged = mergeKnowledgeBatches("course", 1, [first, second, second], [a, b]);
  expect(merged.nodes).toHaveLength(1);
  expect(merged.nodes[0]).toMatchObject({ id: first.nodes[0]!.id, evidenceChunkIds: ["a", "b"], status: "needs_check" });
  const oldId = first.nodes[0]!.id;
  const rebuilt = retainKnowledgeIdentities(merged, [a, b], first, [oldId], { [oldId]: knowledgeNodeDefinition(first.nodes[0]!, [a])! });
  // Production extraction starts with new UUIDs, not the previous graph's UUIDs.
  const fresh = mergeKnowledgeBatches("course", 2, [reconcileExtractedSnapshot("course", 2, graph(a.id), [a]), second], [a, b]);
  const retained = retainKnowledgeIdentities(fresh, [a, b], first, [oldId], { [oldId]: knowledgeNodeDefinition(first.nodes[0]!, [a])! });
  expect(rebuilt.nodes[0]!.evidenceChunkIds).toEqual(["a", "b"]);
  expect(retained.nodes).toHaveLength(2);
  expect(retained.nodes.find(node => node.id === oldId)).toMatchObject({ evidenceChunkIds: ["a"], status: "needs_check" });
  expect(retained.nodes.find(node => node.id !== oldId)!.evidenceChunkIds).toEqual(["a", "b"]);
});

it.each([
  { text: "x2 + x₁" }, { text: "x² + x1" }, { text: "x² - x₁" }, { text: "x² + x₁ " },
  { text: "" }, { imageObjectKey: "figure" }, { startMs: 0, endMs: 100 }, { courseId: "foreign" },
])("does not infer exact equivalence for changed or unprovable evidence: %j", overrides => {
  const a = chunk("a", "x² + x₁"), b = { ...chunk("b", "x² + x₁", "lecture"), ...overrides };
  const first = reconcileExtractedSnapshot("course", 1, graph(a.id), [a]);
  const second = reconcileExtractedSnapshot("course", 1, graph(b.id), [b]);
  expect(mergeKnowledgeBatches("course", 1, [first, second], [a, b]).nodes).toHaveLength(2);
});

it("keeps different labels/kinds, ambiguous definitions, and sliced evidence separate", () => {
  const a = chunk("a", "same"), b = chunk("b", "same", "lecture");
  const first = reconcileExtractedSnapshot("course", 1, graph(a.id), [a]);
  const second = reconcileExtractedSnapshot("course", 1, graph(b.id), [b]);
  for (const change of [{ label: "other" }, { kind: "procedure" as const }]) {
    const changed = { ...second, nodes: second.nodes.map(node => ({ ...node, ...change })) };
    expect(mergeKnowledgeBatches("course", 1, [first, changed], [a, b]).nodes).toHaveLength(2);
  }
  expect(mergeKnowledgeBatches("course", 1, [first, second], [a, b], new Set([a.id])).nodes).toHaveLength(2);
  const ambiguous = reconcileExtractedSnapshot("course", 1, { nodes: [...graph(a.id).nodes, ...graph(a.id).nodes], edges: [] }, [a]);
  expect(mergeKnowledgeBatches("course", 1, [ambiguous, second], [a, b]).nodes).toHaveLength(3);
});
