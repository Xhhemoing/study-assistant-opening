import { describe, expect, it, vi } from "vitest";
import { providerInputSchema, type KnowledgeSnapshot, type ProviderInput, type SourceChunk } from "@aistudy/contracts";
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
        extractedSourceVersions: { [sourceId]: 1 },
        extractedChunkDigests: { [sourceId]: expect.stringMatching(/^[0-9a-f]{64}$/) },
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
      expect.objectContaining({ expectedVersion: 0, extractedSourceVersions: {}, sourceVersions: {} }),
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

  it("sends valid provider chunks while retaining the job's scoped evidence", async () => {
    const owned = chunk({ sourceId: "00000000-0000-4000-8000-0000000000b1" });
    const otherCourse = chunk({ id: foreignChunkId, courseId: "00000000-0000-4000-8000-0000000000c2" });
    const complete = vi.fn(async (input: ProviderInput) => {
      expect(providerInputSchema.parse(input).chunks).toEqual([
        expect.objectContaining({ id: chunkId, sourceId: owned.sourceId, text: owned.text }),
      ]);
      return {
        text: JSON.stringify({ nodes: [{ label: "定义域", kind: "concept", evidenceChunkIds: [chunkId, foreignChunkId] }], edges: [] }),
        citedChunkIds: [], requestId: null, candidates: [], inputTokens: 1, outputTokens: 1,
      };
    });
    const resolveProvider = vi.fn(async () => ({ complete }));
    const handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: async () => [owned, otherCourse],
      get: async () => null,
      replace: async (_s, _c, input) => ({ version: input.expectedVersion + 1, snapshot: input.snapshot }),
      resolveProvider,
    });
    const { snapshot } = await handler(job, { courseId });
    expect(resolveProvider).toHaveBeenCalledWith({ workspaceId: job.workspaceId, ownerUserId: job.ownerUserId }, job,
      expect.objectContaining({ index: 0, count: 1, chunks: [owned] }));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(snapshot.nodes).toMatchObject([{ courseId, label: "定义域", status: "supported", evidenceChunkIds: [chunkId] }]);
  });

  it("extracts chapters independently and does not publish a partial graph if a later chapter fails", async () => {
    const replace = vi.fn();
    const resolveProvider = vi.fn(async (_scope, _job, batch) => ({ complete: vi.fn(async () => {
      if (batch.index === 1) throw new Error("chapter unavailable");
      return { text: JSON.stringify({ nodes: [], edges: [] }), citedChunkIds: [], requestId: null, candidates: [], inputTokens: 1, outputTokens: 1 };
    }) }));
    const handler = createBuildCourseKnowledgeHandler({ get: async () => null, replace, resolveProvider,
      listAuthorizedChunks: async () => [chunk({ text: "# 第一章\n函数" }), chunk({ id: foreignChunkId, text: "# 第二章\n极限" })] });
    await expect(handler(job, { courseId })).rejects.toThrow("chapter unavailable");
    expect(resolveProvider.mock.calls.map(call => [call[2].index, call[2].count])).toEqual([[0, 2], [1, 2]]);
    expect(replace).not.toHaveBeenCalled();
  });

  it.each([false, true])("links a later chapter to a unique earlier concept without guessing ambiguous labels (%s)", async ambiguous => {
    const earlier = chunk({ text: "# 第一章\n向量空间" });
    const later = chunk({ id: foreignChunkId, text: "# 第二章\n线性无关建立在向量空间上" });
    const handler = createBuildCourseKnowledgeHandler({ get: async () => null,
      listAuthorizedChunks: async () => [earlier, later],
      extractGraph: async chunks => chunks[0]!.id === earlier.id ? { nodes: [
        { label: "向量空间", kind: "concept", evidenceChunkIds: [earlier.id] },
        ...(ambiguous ? [{ label: "向量空间", kind: "procedure" as const, evidenceChunkIds: [earlier.id] }] : []),
      ], edges: [] } : { nodes: [{ label: "线性无关", kind: "concept", evidenceChunkIds: [later.id] }],
        edges: [{ fromLabel: "向量空间", toLabel: "线性无关", kind: "prerequisite", evidenceChunkIds: [later.id, "invented-id"] }] },
      replace: async (_scope, _course, input) => ({ version: 1, snapshot: input.snapshot }),
    });
    const { snapshot } = await handler(job, { courseId });
    expect(snapshot.edges).toHaveLength(ambiguous ? 0 : 1);
    if (!ambiguous) expect(snapshot.edges[0]).toMatchObject({
      from: snapshot.nodes.find(node => node.label === "向量空间")!.id,
      to: snapshot.nodes.find(node => node.label === "线性无关")!.id,
      kind: "prerequisite", evidenceChunkIds: [later.id], status: "supported",
    });
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

  it("returns coveredSourceVersions across all authorized chunks and triggers best-effort onBuildCompleted", async () => {
    const unusedSourceId = "00000000-0000-4000-8000-0000000000s2";
    const onBuildCompleted = vi.fn(async () => {
      throw new Error("best-effort hook error");
    });
    const handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: async () => [
        chunk({ sourceVersion: 1 }),
        chunk({ id: foreignChunkId, sourceId: unusedSourceId, sourceVersion: 3 }),
      ],
      get: async () => null,
      extractGraph: async () => ({
        nodes: [{ label: "函数", kind: "concept", evidenceChunkIds: [chunkId], status: "supported" }],
        edges: [],
      }),
      replace: async (_s, _c, input) => ({ version: input.expectedVersion + 1, snapshot: input.snapshot }),
      onBuildCompleted,
    });
    const result = await handler(job as never, { courseId });
    expect(result.coveredSourceVersions).toEqual({ [sourceId]: 1, [unusedSourceId]: 3 });
    expect(onBuildCompleted).toHaveBeenCalledWith(
      { workspaceId: job.workspaceId, ownerUserId: job.ownerUserId },
      courseId,
      { [sourceId]: 1, [unusedSourceId]: 3 },
    );
  });

  it("passes readable zero-node coverage to replace and publishes its committed value", async () => {
    const replace = vi.fn<Parameters<typeof createBuildCourseKnowledgeHandler>[0]["replace"]>(async (_scope, _courseId, input) => ({
      version: input.expectedVersion + 1,
      snapshot: { ...input.snapshot, coveredSourceVersions: input.extractedSourceVersions },
    }));
    const onBuildCompleted = vi.fn(async () => {});
    const handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: async () => [chunk({ sourceVersion: 1 })],
      get: async () => null,
      extractGraph: async () => ({ nodes: [], edges: [] }),
      replace,
      onBuildCompleted,
    });
    await expect(handler(job as never, { courseId })).resolves.toMatchObject({
      coveredSourceVersions: { [sourceId]: 1 },
      snapshot: { nodes: [], coveredSourceVersions: { [sourceId]: 1 } },
    });
    expect(replace).toHaveBeenCalledWith(expect.anything(), courseId, expect.objectContaining({
      sourceVersions: {}, extractedSourceVersions: { [sourceId]: 1 },
    }));
    expect(onBuildCompleted).toHaveBeenCalledWith(expect.anything(), courseId, { [sourceId]: 1 });
  });

  it("retries replace once on CAS CONFLICT after re-reading the latest snapshot and referenced nodes", async () => {
    const initial = reconcileExtractedSnapshot(
      courseId,
      1,
      { nodes: [{ label: "函数", kind: "concept", evidenceChunkIds: [chunkId] }], edges: [] },
      [chunk()],
    );
    const confirmed = {
      ...initial,
      version: 2,
      nodes: [{ ...initial.nodes[0]!, status: "supported" as const }],
    };
    const get = vi.fn()
      .mockResolvedValueOnce({ version: 1, snapshot: initial, sourceVersions: { [sourceId]: 1 } })
      .mockResolvedValueOnce({ version: 2, snapshot: confirmed, sourceVersions: { [sourceId]: 1 } });
    const listReferencedNodeIds = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([confirmed.nodes[0]!.id]);
    const replace = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("stale knowledge version"), { code: "CONFLICT" }))
      .mockImplementationOnce(async (_scope, _courseId, input) => ({
        version: input.expectedVersion + 1,
        snapshot: input.snapshot,
      }));
    const handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: async () => [chunk()],
      listReferencedNodeIds,
      get,
      extractGraph: async () => ({
        nodes: [{ label: "函数", kind: "concept", evidenceChunkIds: [chunkId], status: "supported" }],
        edges: [],
      }),
      replace,
    });
    const result = await handler(job as never, { courseId });
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace.mock.calls[0]![2].expectedVersion).toBe(1);
    expect(replace.mock.calls[1]![2].expectedVersion).toBe(2);
    expect(replace.mock.calls[1]![2].expectedReferencedNodeIds).toEqual([confirmed.nodes[0]!.id]);
    expect(result.version).toBe(3);
    expect(result.coveredSourceVersions).toEqual({ [sourceId]: 1 });
  });

  it("D1: excludes whitespace-only and pure-image chunks from extraction and coveredSourceVersions while keeping mixed image+text sources", async () => {
    const pureImageSource = "00000000-0000-4000-8000-0000000000s2";
    const blankSource = "00000000-0000-4000-8000-0000000000s3";
    const mixedSource = "00000000-0000-4000-8000-0000000000s4";
    const extractGraph = vi.fn(async () => ({ nodes: [], edges: [] }));
    const replace = vi.fn(async (_scope, _courseId, input) => ({
      version: input.expectedVersion + 1,
      snapshot: input.snapshot,
    }));
    const handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: async () => [
        chunk({ id: "00000000-0000-4000-8000-0000000000b1", sourceId: pureImageSource, text: "", imageObjectKey: "img/1.png" }),
        chunk({ id: "00000000-0000-4000-8000-0000000000b2", sourceId: blankSource, text: "   \n\t  ", imageObjectKey: null }),
        chunk({ id: "00000000-0000-4000-8000-0000000000b3", sourceId: mixedSource, text: "", imageObjectKey: "img/2.png" }),
        chunk({ id: "00000000-0000-4000-8000-0000000000b4", sourceId: mixedSource, sourceVersion: 2, text: "线性代数", imageObjectKey: null }),
      ],
      get: async () => null,
      extractGraph,
      replace,
    });
    const result = await handler(job as never, { courseId });
    expect(extractGraph).toHaveBeenCalledTimes(1);
    expect(extractGraph.mock.calls[0]?.[0].map((c) => c.sourceId)).toEqual([mixedSource]);
    expect(result.coveredSourceVersions).toEqual({ [mixedSource]: 2 });
    expect(replace.mock.calls[0]?.[2].extractedSourceVersions).toEqual({ [mixedSource]: 2 });
  });

  it("D4: does not retry replace when rejected with MATERIAL_REPLACEMENT_BLOCKED", async () => {
    const get = vi.fn().mockResolvedValue({ version: 1, snapshot: { courseId, version: 1, nodes: [], edges: [] }, sourceVersions: { [sourceId]: 1 } });
    const replace = vi.fn().mockRejectedValue(
      Object.assign(new Error("blocked"), { code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" }),
    );
    const handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: async () => [],
      get,
      extractGraph: async () => ({ nodes: [], edges: [] }),
      replace,
    });
    await expect(handler(job as never, { courseId })).rejects.toMatchObject({
      code: "CONFLICT",
      reason: "MATERIAL_REPLACEMENT_BLOCKED",
    });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("aborts CAS retry without overwriting when J2 already committed V@2 not covered by stale J1 batch", async () => {
    const v2ChunkId = "00000000-0000-4000-8000-0000000000a2";
    const j2Snapshot = reconcileExtractedSnapshot(
      courseId,
      2,
      { nodes: [{ label: "新版V2概念", kind: "concept", evidenceChunkIds: [v2ChunkId], status: "supported" }], edges: [] },
      [chunk({ id: v2ChunkId, sourceVersion: 2 })],
    );
    const get = vi.fn()
      // Initial read before J2 committed V@2 (graph was empty / v1)
      .mockResolvedValueOnce({ version: 1, snapshot: { courseId, version: 1, nodes: [], edges: [] }, sourceVersions: {} })
      // Re-read after CAS conflict sees J2's committed V@2 graph
      .mockResolvedValueOnce({ version: 2, snapshot: j2Snapshot, sourceVersions: { [sourceId]: 2 } });
    const replace = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("stale knowledge version"), { code: "CONFLICT" }),
    );
    const handler = createBuildCourseKnowledgeHandler({
      // Stale J1 extracted before V@2 was available (empty / uncovered V@2)
      listAuthorizedChunks: async () => [],
      get,
      extractGraph: async () => ({ nodes: [], edges: [] }),
      replace,
    });
    await expect(handler(job as never, { courseId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(get).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
