import { describe, expect, it, vi } from "vitest";
import type { KnowledgeSnapshot, SourceChunk } from "@aistudy/contracts";
import {
  createBuildCourseKnowledgeHandler,
  reconcileExtractedSnapshot,
  sourceVersionsFromChunks,
  type AuthorizedChunk,
} from "./build-course-knowledge";

const courseId = "00000000-0000-4000-8000-0000000000c1";
const chunkId = "00000000-0000-4000-8000-0000000000a1";
const foreignChunkId = "00000000-0000-4000-8000-0000000000a9";
const sourceId = "00000000-0000-4000-8000-0000000000s1";

function chunk(overrides: Partial<AuthorizedChunk> = {}): AuthorizedChunk {
  const base: SourceChunk = {
    id: chunkId,
    sourceId,
    sourceVersion: 1,
    page: 1,
    slideLabel: null,
    startMs: null,
    endMs: null,
    text: "函数的定义域",
    imageObjectKey: null,
  };
  return { ...base, courseId, ...overrides };
}

const job = {
  id: "00000000-0000-4000-8000-0000000000j1",
  workspaceId: "00000000-0000-4000-8000-0000000000w1",
  ownerUserId: "00000000-0000-4000-8000-0000000000u1",
  key: "knowledge:rebuild",
  kind: "build-course-knowledge",
  payload: {},
  result: null,
  state: "running" as const,
  privacyEpoch: 0,
};

describe("reconcileExtractedSnapshot", () => {
  it("drops unauthorized evidence and marks empty supported nodes as suggested", () => {
    const snapshot = reconcileExtractedSnapshot(
      courseId,
      2,
      {
        nodes: [
          { label: "函数", kind: "concept", evidenceChunkIds: [chunkId, foreignChunkId], status: "supported" },
          { label: "无据", kind: "concept", evidenceChunkIds: [foreignChunkId], status: "supported" },
        ],
        edges: [],
      },
      [chunk()],
    );
    expect(snapshot.nodes).toHaveLength(2);
    const withEvidence = snapshot.nodes.find((node) => node.label === "函数")!;
    expect(withEvidence.evidenceChunkIds).toEqual([chunkId]);
    expect(withEvidence.status).toBe("supported");
    const empty = snapshot.nodes.find((node) => node.label === "无据")!;
    expect(empty.evidenceChunkIds).toEqual([]);
    expect(empty.status).toBe("suggested");
  });

  it("marks material-free prerequisite edges as suggested without forging evidence", () => {
    const snapshot = reconcileExtractedSnapshot(
      courseId,
      1,
      {
        nodes: [
          { label: "A", kind: "concept", evidenceChunkIds: [chunkId], status: "supported" },
          { label: "B", kind: "concept", evidenceChunkIds: [chunkId], status: "supported" },
        ],
        edges: [
          { fromLabel: "A", toLabel: "B", kind: "prerequisite", evidenceChunkIds: [], status: "supported" },
        ],
      },
      [chunk()],
    );
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]).toMatchObject({ kind: "prerequisite", status: "suggested", evidenceChunkIds: [] });
  });

  it("ignores chunks from another course", () => {
    const snapshot = reconcileExtractedSnapshot(
      courseId,
      1,
      {
        nodes: [{ label: "外课", kind: "concept", evidenceChunkIds: [chunkId], status: "supported" }],
        edges: [],
      },
      [chunk({ courseId: "00000000-0000-4000-8000-0000000000c9" })],
    );
    expect(snapshot.nodes[0]!.evidenceChunkIds).toEqual([]);
    expect(snapshot.nodes[0]!.status).toBe("suggested");
  });
  it("reuses only an unambiguous exact definition anchored to the same immutable evidence", () => {
    const extracted = { nodes: [{ label: "函数", kind: "concept" as const, evidenceChunkIds: [chunkId], status: "supported" as const }], edges: [] };
    const first = reconcileExtractedSnapshot(courseId, 1, extracted, [chunk()]);
    const rebuilt = reconcileExtractedSnapshot(courseId, 2, extracted, [chunk()], first);
    expect(rebuilt.nodes[0]!.id).toBe(first.nodes[0]!.id);
    const renamed = reconcileExtractedSnapshot(courseId, 2, { ...extracted, nodes: [{ ...extracted.nodes[0]!, label: "函数的新定义" }] }, [chunk()], first);
    expect(renamed.nodes[0]!.id).not.toBe(first.nodes[0]!.id);
    const changed = reconcileExtractedSnapshot(courseId, 2, { ...extracted, nodes: [{ ...extracted.nodes[0]!, evidenceChunkIds: [foreignChunkId] }] },
      [chunk({ id: foreignChunkId, sourceVersion: 2 })], first);
    expect(changed.nodes[0]!.id).not.toBe(first.nodes[0]!.id);
    const split = reconcileExtractedSnapshot(courseId, 2, { ...extracted, nodes: [extracted.nodes[0]!, extracted.nodes[0]!] }, [chunk()], first);
    expect(split.nodes.some(node => node.id === first.nodes[0]!.id)).toBe(false);
    const retainedSplit = reconcileExtractedSnapshot(courseId, 2, { ...extracted, nodes: [extracted.nodes[0]!, extracted.nodes[0]!] }, [chunk()], first, [first.nodes[0]!.id]);
    expect(retainedSplit.nodes.find(node => node.id === first.nodes[0]!.id)?.status).toBe("needs_check");
    expect(reconcileExtractedSnapshot(courseId, 3, extracted, [chunk()], {
      ...retainedSplit, nodes: retainedSplit.nodes.filter(node => node.id === first.nodes[0]!.id),
    }).nodes[0]!.status).toBe("needs_check");
  });

  it("retains referenced original definitions on model omission without reviving deleted or unavailable identities", () => {
    const first = reconcileExtractedSnapshot(courseId, 1, { nodes: [{ label: "函数", kind: "concept", evidenceChunkIds: [chunkId] }], edges: [] }, [chunk()]);
    const id = first.nodes[0]!.id;
    const rebuilt = reconcileExtractedSnapshot(courseId, 2, { nodes: [], edges: [] }, [chunk()], first, [id]);
    expect(rebuilt.nodes).toEqual(first.nodes);
    expect(reconcileExtractedSnapshot(courseId, 2, { nodes: [], edges: [] }, [], first, [id]).nodes).toEqual([]);
    expect(reconcileExtractedSnapshot(courseId, 3, { nodes: [], edges: [] }, [chunk()], { ...first, nodes: [] }, [id]).nodes).toEqual([]);
  });
});

describe("sourceVersionsFromChunks", () => {
  it("keeps the highest version per source", () => {
    expect(sourceVersionsFromChunks([
      chunk({ sourceVersion: 1 }),
      chunk({ id: foreignChunkId, sourceVersion: 3 }),
      chunk({ id: "00000000-0000-4000-8000-0000000000a2", sourceId: "00000000-0000-4000-8000-0000000000s2", sourceVersion: 2 }),
    ])).toEqual({ [sourceId]: 3, "00000000-0000-4000-8000-0000000000s2": 2 });
  });
});

describe("createBuildCourseKnowledgeHandler", () => {
  it("keeps referenced identities when a real rebuild omits their nodes and pins only used sources", async () => {
    const current = reconcileExtractedSnapshot(courseId, 1, { nodes: [{ label: "函数", kind: "concept", evidenceChunkIds: [chunkId] }], edges: [] }, [chunk()]);
    const referenced = vi.fn(async () => [current.nodes[0]!.id]);
    const replace = vi.fn(async (_scope, _course, input) => ({ version: 2, snapshot: input.snapshot }));
    const handler = createBuildCourseKnowledgeHandler({
      get: async () => ({ version: 1, snapshot: current, sourceVersions: { [sourceId]: 1 } }),
      listAuthorizedChunks: async () => [chunk(), chunk({ id: foreignChunkId, sourceId: "unused-source" })],
      listReferencedNodeIds: referenced, extractGraph: async () => ({ nodes: [], edges: [] }), replace,
      validateSnapshot: value => value,
    });
    expect((await handler(job, { courseId })).snapshot.nodes).toEqual(current.nodes);
    expect(referenced).toHaveBeenCalledWith({ workspaceId: job.workspaceId, ownerUserId: job.ownerUserId }, courseId);
    expect(replace.mock.calls[0]![2].sourceVersions).toEqual({ [sourceId]: 1 });
    expect(replace.mock.calls[0]![2].expectedReferencedNodeIds).toEqual([current.nodes[0]!.id]);
  });
  it("reads current version, validates, then replace with CAS and sourceVersions", async () => {
    const authorized = [chunk()];
    const validateSnapshot = vi.fn((snapshot: KnowledgeSnapshot) => snapshot);
    const replace = vi.fn(async (_scope, _courseId, input) => ({
      version: input.expectedVersion + 1,
      snapshot: input.snapshot,
    }));
    const handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: async () => authorized,
      get: async () => ({ version: 3, snapshot: { courseId, version: 3, nodes: [], edges: [] }, sourceVersions: {} }),
      validateSnapshot,
      replace,
      provider: null,
      extractGraph: async () => ({
        nodes: [{ label: "函数", kind: "concept", evidenceChunkIds: [chunkId], status: "supported" }],
        edges: [],
      }),
    });
    const result = await handler(job as never, { courseId });
    expect(validateSnapshot).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(
      { workspaceId: job.workspaceId, ownerUserId: job.ownerUserId },
      courseId,
      {
        expectedVersion: 3,
        snapshot: expect.objectContaining({ courseId, version: 4, nodes: [expect.objectContaining({ label: "函数" })] }),
        sourceVersions: { [sourceId]: 1 },
      },
    );
    expect(result.version).toBe(4);
  });

  it("uses expectedVersion 0 when no snapshot exists yet", async () => {
    const replace = vi.fn(async (_scope, _courseId, input) => ({
      version: input.expectedVersion + 1,
      snapshot: input.snapshot,
    }));
    const handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: async () => [],
      get: async () => null,
      validateSnapshot: (snapshot) => snapshot,
      replace,
      provider: null,
      extractGraph: async () => ({ nodes: [], edges: [] }),
    });
    await handler(job as never, { courseId });
    expect(replace).toHaveBeenCalledWith(
      expect.anything(),
      courseId,
      expect.objectContaining({ expectedVersion: 0, sourceVersions: {} }),
    );
  });

  it("does not replace when validation throws", async () => {
    const replace = vi.fn();
    const handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: async () => [chunk()],
      get: async () => ({ version: 0, snapshot: { courseId, version: 0, nodes: [], edges: [] }, sourceVersions: {} }),
      validateSnapshot: () => {
        throw new Error("self prerequisite");
      },
      replace,
      provider: null,
      extractGraph: async () => ({
        nodes: [{ label: "A", kind: "concept", evidenceChunkIds: [chunkId] }],
        edges: [{ fromLabel: "A", toLabel: "A", kind: "prerequisite", evidenceChunkIds: [chunkId] }],
      }),
    });
    await expect(handler(job as never, { courseId })).rejects.toThrow("self prerequisite");
    expect(replace).not.toHaveBeenCalled();
  });

  it("resolves the live provider per job so the extraction call has its own ledger key", async () => {
    const complete = vi.fn(async () => ({
      text: JSON.stringify({ nodes: [{ label: "定义域", kind: "concept", evidenceChunkIds: [chunkId] }], edges: [] }),
      citedChunkIds: [], requestId: null, candidates: [], inputTokens: 1, outputTokens: 1,
    }));
    const resolveProvider = vi.fn(async () => ({ complete }));
    const handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: async () => [chunk()],
      get: async () => null,
      validateSnapshot: (snapshot) => snapshot,
      replace: async (_s, _c, input) => ({ version: input.expectedVersion + 1, snapshot: input.snapshot }),
      resolveProvider,
    });
    await handler(job as never, { courseId });
    expect(resolveProvider).toHaveBeenCalledWith({ workspaceId: job.workspaceId, ownerUserId: job.ownerUserId }, job);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing courseId payload", async () => {
    const handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: async () => [],
      get: async () => null,
      validateSnapshot: (snapshot) => snapshot,
      replace: async (_s, _c, input) => ({ version: input.expectedVersion + 1, snapshot: input.snapshot }),
      provider: null,
    });
    await expect(handler(job as never, {})).rejects.toThrow("missing courseId");
  });
});
