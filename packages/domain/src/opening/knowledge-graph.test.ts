import { describe, expect, it } from "vitest";
import type { KnowledgeEdge, KnowledgeNode, KnowledgeSnapshot } from "@aistudy/contracts";
import { validateKnowledgeSnapshot } from "./knowledge-graph";

const courseId = "11111111-1111-4111-8111-111111111111";
const chunkId = "22222222-2222-4222-8222-222222222222";
const n1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const n2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const n3 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";

function node(partial: Partial<KnowledgeNode> & Pick<KnowledgeNode, "id" | "label">): KnowledgeNode {
  return {
    courseId,
    kind: "concept",
    evidenceChunkIds: [chunkId],
    status: "supported",
    ...partial,
  };
}

function edge(partial: Partial<KnowledgeEdge> & Pick<KnowledgeEdge, "from" | "to" | "kind">): KnowledgeEdge {
  return {
    evidenceChunkIds: [chunkId],
    status: "supported",
    ...partial,
  };
}

function snapshot(partial: Partial<KnowledgeSnapshot> = {}): KnowledgeSnapshot {
  return {
    courseId,
    version: 1,
    nodes: [node({ id: n1, label: "函数" }), node({ id: n2, label: "映射" })],
    edges: [edge({ from: n1, to: n2, kind: "prerequisite" })],
    ...partial,
  };
}

describe("validateKnowledgeSnapshot", () => {
  it("accepts a valid DAG snapshot", () => {
    expect(validateKnowledgeSnapshot(snapshot()).nodes).toHaveLength(2);
  });

  it("rejects a self prerequisite", () => {
    const n = node({ id: n1, label: "函数" });
    expect(() =>
      validateKnowledgeSnapshot({
        courseId,
        version: 1,
        nodes: [n],
        edges: [edge({ from: n1, to: n1, kind: "prerequisite" })],
      }),
    ).toThrow(/self prerequisite/i);
  });

  it("rejects a prerequisite cycle", () => {
    expect(() =>
      validateKnowledgeSnapshot(
        snapshot({
          nodes: [node({ id: n1, label: "A" }), node({ id: n2, label: "B" }), node({ id: n3, label: "C" })],
          edges: [
            edge({ from: n1, to: n2, kind: "prerequisite" }),
            edge({ from: n2, to: n3, kind: "prerequisite" }),
            edge({ from: n3, to: n1, kind: "prerequisite" }),
          ],
        }),
      ),
    ).toThrow(/cycle/i);
  });

  it("allows contains cycles (non-DAG relation)", () => {
    expect(
      validateKnowledgeSnapshot(
        snapshot({
          edges: [
            edge({ from: n1, to: n2, kind: "contains" }),
            edge({ from: n2, to: n1, kind: "contains" }),
          ],
        }),
      ).edges,
    ).toHaveLength(2);
  });

  it("rejects edges referencing missing nodes", () => {
    expect(() =>
      validateKnowledgeSnapshot(
        snapshot({
          edges: [edge({ from: n1, to: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1", kind: "applies_to" })],
        }),
      ),
    ).toThrow(/missing node/i);
  });

  it("rejects supported nodes without evidence", () => {
    expect(() =>
      validateKnowledgeSnapshot(
        snapshot({
          nodes: [node({ id: n1, label: "空", evidenceChunkIds: [], status: "supported" })],
          edges: [],
        }),
      ),
    ).toThrow(/evidenceChunkIds/i);
  });

  it("rejects courseId mismatch on nodes", () => {
    expect(() =>
      validateKnowledgeSnapshot(
        snapshot({
          nodes: [node({ id: n1, label: "外", courseId: "99999999-9999-4999-8999-999999999999" })],
          edges: [],
        }),
      ),
    ).toThrow(/courseId/i);
  });

  it("rejects duplicate node ids", () => {
    expect(() =>
      validateKnowledgeSnapshot(
        snapshot({
          nodes: [node({ id: n1, label: "A" }), node({ id: n1, label: "B" })],
          edges: [],
        }),
      ),
    ).toThrow(/duplicate/i);
  });
});
