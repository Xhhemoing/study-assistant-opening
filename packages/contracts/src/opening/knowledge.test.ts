import { describe, expect, it } from "vitest";
import {
  courseKnowledgeRecordResponseSchema,
  courseKnowledgeSyncSchema,
  courseKnowledgeSyncStatusSchema,
  knowledgeEdgeSchema,
  knowledgeNodeSchema,
  knowledgeSnapshotSchema,
  skillEvidenceSchema,
  tutorActionSchema,
  type CourseKnowledgeRecordResponse,
  type CourseKnowledgeSync,
  type CourseKnowledgeSyncStatus,
} from "./knowledge";
import {
  courseKnowledgeRecordResponseSchema as openingRecordResponseSchema,
  courseKnowledgeSyncSchema as openingSyncSchema,
  courseKnowledgeSyncStatusSchema as openingSyncStatusSchema,
} from "./index";
import {
  courseKnowledgeRecordResponseSchema as barrelRecordResponseSchema,
} from "../index";

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

  it("validates courseKnowledgeSyncStatusSchema and courseKnowledgeSyncSchema", () => {
    for (const status of ["empty", "up_to_date", "pending", "needs_rebuild"] as const) {
      const parsed: CourseKnowledgeSyncStatus = courseKnowledgeSyncStatusSchema.parse(status);
      expect(parsed).toBe(status);
      expect(openingSyncStatusSchema.parse(status)).toBe(status);
    }
    expect(courseKnowledgeSyncStatusSchema.safeParse("stale").success).toBe(false);

    const syncPayload: CourseKnowledgeSync = {
      status: "needs_rebuild",
      activeJobId: nodeId,
      lastBuiltVersion: 2,
      coveredSourceVersions: { [chunkId]: 1 },
      eligibleSourceVersions: { [chunkId]: 2, [otherNode]: 0 },
      parsingSourceCount: 1,
    };
    expect(courseKnowledgeSyncSchema.parse(syncPayload)).toEqual(syncPayload);
    expect(openingSyncSchema.parse(syncPayload)).toEqual(syncPayload);

    const emptySync: CourseKnowledgeSync = {
      status: "empty",
      activeJobId: null,
      lastBuiltVersion: null,
      coveredSourceVersions: {},
      eligibleSourceVersions: {},
      parsingSourceCount: 0,
    };
    expect(courseKnowledgeSyncSchema.parse(emptySync)).toEqual(emptySync);
  });

  it("validates courseKnowledgeRecordResponseSchema with and without sync", () => {
    const snapshot = {
      courseId,
      version: 3,
      nodes: [
        {
          id: nodeId,
          courseId,
          label: "极限与连续",
          kind: "concept" as const,
          evidenceChunkIds: [chunkId],
          status: "supported" as const,
        },
      ],
      edges: [],
    };
    const withoutSync: CourseKnowledgeRecordResponse = {
      version: 3,
      snapshot,
      sourceVersions: { [chunkId]: 2 },
    };
    expect(courseKnowledgeRecordResponseSchema.parse(withoutSync)).toEqual(withoutSync);
    expect(openingRecordResponseSchema.parse(withoutSync)).toEqual(withoutSync);
    expect(barrelRecordResponseSchema.parse(withoutSync)).toEqual(withoutSync);

    const withSync: CourseKnowledgeRecordResponse = {
      ...withoutSync,
      sync: {
        status: "up_to_date",
        activeJobId: null,
        lastBuiltVersion: 3,
        coveredSourceVersions: { [chunkId]: 2 },
        eligibleSourceVersions: { [chunkId]: 2 },
        parsingSourceCount: 0,
      },
    };
    expect(courseKnowledgeRecordResponseSchema.parse(withSync)).toEqual(withSync);
  });

  it("rejects invalid values and extra fields on sync and record response schemas", () => {
    const validSync = {
      status: "pending" as const,
      activeJobId: nodeId,
      lastBuiltVersion: 1,
      coveredSourceVersions: { [chunkId]: 1 },
      eligibleSourceVersions: { [chunkId]: 1 },
      parsingSourceCount: 0,
    };

    expect(
      courseKnowledgeSyncSchema.safeParse({ ...validSync, extraField: true }).success,
    ).toBe(false);
    expect(
      courseKnowledgeSyncSchema.safeParse({ ...validSync, activeJobId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      courseKnowledgeSyncSchema.safeParse({ ...validSync, lastBuiltVersion: -1 }).success,
    ).toBe(false);
    expect(
      courseKnowledgeSyncSchema.safeParse({ ...validSync, parsingSourceCount: -1 }).success,
    ).toBe(false);
    expect(
      courseKnowledgeSyncSchema.safeParse({ ...validSync, coveredSourceVersions: { [chunkId]: -1 } }).success,
    ).toBe(false);
    expect(
      courseKnowledgeSyncSchema.safeParse({ ...validSync, eligibleSourceVersions: { [chunkId]: 1.5 } }).success,
    ).toBe(false);

    const validResponse = {
      version: 1,
      snapshot: {
        courseId,
        version: 1,
        nodes: [],
        edges: [],
      },
      sourceVersions: { [chunkId]: 0 },
      sync: validSync,
    };

    expect(
      courseKnowledgeRecordResponseSchema.safeParse({ ...validResponse, extra: "nope" }).success,
    ).toBe(false);
    expect(
      courseKnowledgeRecordResponseSchema.safeParse({ ...validResponse, version: -1 }).success,
    ).toBe(false);
    expect(
      courseKnowledgeRecordResponseSchema.safeParse({
        ...validResponse,
        sourceVersions: { [chunkId]: -2 },
      }).success,
    ).toBe(false);
    expect(
      courseKnowledgeRecordResponseSchema.safeParse({
        ...validResponse,
        sync: { ...validSync, status: "unknown" },
      }).success,
    ).toBe(false);
  });

  it("validates optional syncDetails fields and rejects error leakage or invalid job states", () => {
    const detailedSync: CourseKnowledgeSync = {
      status: "needs_rebuild",
      activeJobId: null,
      lastBuiltVersion: 2,
      coveredSourceVersions: { [chunkId]: 1 },
      eligibleSourceVersions: {},
      parsingSourceCount: 0,
      unreadableSourceCount: 1,
      rebuildBlockedByMaterials: true,
      lastFailedJob: { jobId: nodeId, state: "outcome_unknown" },
      requestedJob: { jobId: otherNode, state: "cancelled" },
    };
    expect(courseKnowledgeSyncSchema.parse(detailedSync)).toEqual(detailedSync);

    const explicitZerosAndNulls: CourseKnowledgeSync = {
      status: "up_to_date",
      activeJobId: null,
      lastBuiltVersion: 2,
      coveredSourceVersions: { [chunkId]: 1 },
      eligibleSourceVersions: { [chunkId]: 1 },
      parsingSourceCount: 0,
      unreadableSourceCount: 0,
      rebuildBlockedByMaterials: false,
      lastFailedJob: null,
      requestedJob: null,
    };
    expect(courseKnowledgeSyncSchema.parse(explicitZerosAndNulls)).toEqual(explicitZerosAndNulls);

    expect(
      courseKnowledgeSyncSchema.safeParse({ ...detailedSync, unreadableSourceCount: -1 }).success,
    ).toBe(false);
    expect(
      courseKnowledgeSyncSchema.safeParse({
        ...detailedSync,
        lastFailedJob: { jobId: nodeId, state: "failed", error: "provider secret" },
      }).success,
    ).toBe(false);
    expect(
      courseKnowledgeSyncSchema.safeParse({
        ...detailedSync,
        lastFailedJob: { jobId: nodeId, state: "succeeded" },
      }).success,
    ).toBe(false);
    expect(
      courseKnowledgeSyncSchema.safeParse({
        ...detailedSync,
        requestedJob: { jobId: otherNode, state: "failed", error: "leak" },
      }).success,
    ).toBe(false);
    expect(
      courseKnowledgeSyncSchema.safeParse({
        ...detailedSync,
        requestedJob: { jobId: "not-a-uuid", state: "running" },
      }).success,
    ).toBe(false);
  });
});
