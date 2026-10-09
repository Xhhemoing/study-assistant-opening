import { describe, expect, it } from "vitest";
import {
  knowledgeEdgeSchema,
  knowledgeNodeSchema,
  knowledgeSnapshotSchema,
  skillEvidenceSchema,
  tutorActionSchema,
} from "./knowledge";

const courseId = "11111111-1111-4111-8111-111111111111";
const nodeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const chunkId = "22222222-2222-4222-8222-222222222222";
const otherNode = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

describe("knowledge contracts", () => {
  it("round-trips a valid snapshot", () => {
    const snapshot = {
      courseId,
      version: 0,
      nodes: [
        {
          id: nodeId,
          courseId,
          label: "函数",
          kind: "concept" as const,
          evidenceChunkIds: [chunkId],
          status: "supported" as const,
        },
      ],
      edges: [
        {
          from: nodeId,
          to: otherNode,
          kind: "prerequisite" as const,
          evidenceChunkIds: [chunkId],
          status: "suggested" as const,
        },
      ],
    };
    // edge target need not exist at schema layer
    expect(knowledgeSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects non-uuid ids and unknown kinds", () => {
    expect(knowledgeNodeSchema.safeParse({
      id: "n",
      courseId: "c",
      label: "函数",
      kind: "concept",
      evidenceChunkIds: ["chunk"],
      status: "supported",
    }).success).toBe(false);
    expect(knowledgeEdgeSchema.safeParse({
      from: nodeId,
      to: otherNode,
      kind: "depends_on",
      evidenceChunkIds: [],
      status: "suggested",
    }).success).toBe(false);
    expect(knowledgeSnapshotSchema.safeParse({
      courseId,
      version: -1,
      nodes: [],
      edges: [],
    }).success).toBe(false);
  });

  it("keeps skill evidence and tutor action payloads strict", () => {
    expect(skillEvidenceSchema.parse({
      nodeId,
      observationId: chunkId,
      dimension: "recall",
    })).toMatchObject({ dimension: "recall" });
    expect(tutorActionSchema.safeParse({
      nodeId,
      kind: "clarify",
      evidenceIds: [chunkId],
      reason: "需要澄清定义",
      masteryPercent: 80,
    }).success).toBe(false);
  });
});
