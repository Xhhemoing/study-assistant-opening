import { describe, expect, it, vi } from "vitest";
import { mediaSegmentCorrectionInputSchema, mediaSegmentSchema } from "@aistudy/contracts";
import { validateMediaSegments } from "../../../../../worker/src/parsers/media-segments";
import {
  copyOpeningSourceVersionObjects,
  createOpeningMediaSegmentsService,
  linkFrameChunkIds,
  openingSourceVersionPrefix,
  rewriteOpeningSourceVersionKey,
} from "./media-segments-service";

describe("media segment correction contract", () => {
  const segment = {
    sourceId: "11111111-1111-4111-8111-111111111111",
    sourceVersion: 1,
    startMs: 0,
    endMs: 1000,
    text: "课程",
    frameChunkIds: [],
    quality: "needs_check" as const,
  };

  it("parses correction input and validates timing against duration", () => {
    const input = mediaSegmentCorrectionInputSchema.parse({
      expectedVersion: 1,
      durationMs: 1000,
      segments: [segment],
      clientKey: "correct-key-01",
    });
    expect(validateMediaSegments(input.segments, input.durationMs!)).toEqual([
      mediaSegmentSchema.parse(segment),
    ]);
    expect(() =>
      validateMediaSegments([{ ...segment, endMs: 1001 }], 1000),
    ).toThrow(/outside source duration/);
  });

  it("requires clientKey for async corrections receipt", () => {
    expect(() =>
      mediaSegmentCorrectionInputSchema.parse({
        expectedVersion: 1,
        segments: [segment],
      }),
    ).toThrow();
  });
});

describe("linkFrameChunkIds", () => {
  it("links keyframe ids whose timestamp falls inside the segment", () => {
    const frames = [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", startMs: 100 },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", startMs: 1500 },
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", startMs: 900 },
    ];
    expect(linkFrameChunkIds({ startMs: 0, endMs: 1000 }, frames)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ]);
  });
});

describe("opening source version object copy", () => {
  const sourceId = "11111111-1111-4111-8111-111111111111";

  it("rewrites versioned final and frame keys under opening/sources layout", () => {
    expect(openingSourceVersionPrefix(sourceId, 2)).toBe(`opening/sources/${sourceId}/v2`);
    expect(rewriteOpeningSourceVersionKey(`opening/sources/${sourceId}/v1`, sourceId, 1, 2)).toBe(
      `opening/sources/${sourceId}/v2`,
    );
    expect(
      rewriteOpeningSourceVersionKey(`opening/sources/${sourceId}/v1/frames/1200.png`, sourceId, 1, 2),
    ).toBe(`opening/sources/${sourceId}/v2/frames/1200.png`);
    expect(rewriteOpeningSourceVersionKey("other/bucket/key.png", sourceId, 1, 2)).toBe(
      "other/bucket/key.png",
    );
  });

  it("copies finalKey and forwarded frame keys via storage.copyObject", async () => {
    const copies: Array<[string, string]> = [];
    const storage = {
      finalKey: (id: string, version: number) => `opening/sources/${id}/v${version}`,
      copyObject: vi.fn(async (from: string, to: string) => {
        copies.push([from, to]);
      }),
    };
    const frame = `opening/sources/${sourceId}/v3/frames/500.png`;
    const result = await copyOpeningSourceVersionObjects(storage, {
      sourceId,
      fromVersion: 3,
      toVersion: 4,
      frameObjectKeys: [frame, frame],
    });
    expect(result.finalFrom).toBe(`opening/sources/${sourceId}/v3`);
    expect(result.finalTo).toBe(`opening/sources/${sourceId}/v4`);
    expect(copies).toEqual([
      [`opening/sources/${sourceId}/v3`, `opening/sources/${sourceId}/v4`],
      [frame, `opening/sources/${sourceId}/v4/frames/500.png`],
    ]);
    expect(result.frames).toEqual([
      { from: frame, to: `opening/sources/${sourceId}/v4/frames/500.png` },
      { from: frame, to: `opening/sources/${sourceId}/v4/frames/500.png` },
    ]);
  });
});

describe("applyCorrections → K01 markNeedsCheckForSources + enqueueRebuild", () => {
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const courseIdA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const courseIdB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const jobId = "22222222-2222-4222-8222-222222222222";
  const principal = {
    userId: "00000000-0000-4000-8000-0000000000aa",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    sessionId: "sess",
  };
  const segment = {
    sourceId,
    sourceVersion: 1,
    startMs: 0,
    endMs: 1000,
    text: "课程",
    frameChunkIds: [] as string[],
    quality: "needs_check" as const,
  };
  const correctionBody = {
    expectedVersion: 1,
    durationMs: 1000,
    segments: [segment],
    clientKey: "correct-key-01",
  };
  const scope = { workspaceId: principal.workspaceId, ownerUserId: principal.userId };

  function makeService(overrides: {
    markNeedsCheckForSources?: ReturnType<typeof vi.fn>;
    enqueueRebuild?: ReturnType<typeof vi.fn>;
    commitCorrectionBump?: ReturnType<typeof vi.fn>;
  }) {
    const markNeedsCheckForSources =
      overrides.markNeedsCheckForSources ??
      vi.fn(async () => ({ updated: 2, courseIds: [courseIdA, courseIdB] }));
    const enqueueRebuild =
      overrides.enqueueRebuild ??
      vi.fn(async () => ({ jobId: "rebuild-job", kind: "build-course-knowledge" as const, created: true }));
    const commitCorrectionBump =
      overrides.commitCorrectionBump ??
      vi.fn(async () => 2);
    const createOnce = vi.fn(async () => ({
      id: jobId,
      state: "queued" as const,
    }));
    const claim = vi.fn(async () => ({ id: jobId, state: "running" as const }));
    const finish = vi.fn(async () => true);
    const service = createOpeningMediaSegmentsService({} as never, {} as never, {
      sources: {
        get: async () =>
          ({
            id: sourceId,
            version: 1,
            uploadState: "uploaded",
          }) as never,
      },
      privacy: { getWorkspaceEpoch: async () => 0 },
      jobs: { createOnce, claim, finish },
      knowledge: { markNeedsCheckForSources, enqueueRebuild },
      commitCorrectionBump,
    });
    return {
      service,
      markNeedsCheckForSources,
      enqueueRebuild,
      commitCorrectionBump,
      createOnce,
      claim,
      finish,
    };
  }

  it("invokes markNeedsCheckForSources with the corrected sourceId after bump", async () => {
    const { service, markNeedsCheckForSources, commitCorrectionBump } = makeService({});
    const result = await service.applyCorrections(principal, sourceId, correctionBody);
    expect(result).toEqual({ jobId });
    expect(commitCorrectionBump).toHaveBeenCalledOnce();
    expect(markNeedsCheckForSources).toHaveBeenCalledWith(scope, [sourceId]);
    // Ordering: bump commits before knowledge mark.
    const bumpOrder = commitCorrectionBump.mock.invocationCallOrder[0];
    const markOrder = markNeedsCheckForSources.mock.invocationCallOrder[0];
    expect(bumpOrder).toBeLessThan(markOrder);
  });

  it("enqueues full-course rebuild for each course returned by markNeedsCheck", async () => {
    const { service, markNeedsCheckForSources, enqueueRebuild, commitCorrectionBump } = makeService({});
    await service.applyCorrections(principal, sourceId, correctionBody);
    expect(enqueueRebuild).toHaveBeenCalledTimes(2);
    expect(enqueueRebuild).toHaveBeenNthCalledWith(1, scope, courseIdA, {
      clientKey: `media-correction:${sourceId}:v2`,
    });
    expect(enqueueRebuild).toHaveBeenNthCalledWith(2, scope, courseIdB, {
      clientKey: `media-correction:${sourceId}:v2`,
    });
    // Ordering: mark then enqueue (full-course, not time-scoped).
    const markOrder = markNeedsCheckForSources.mock.invocationCallOrder[0];
    const enqueueOrder = enqueueRebuild.mock.invocationCallOrder[0];
    expect(markOrder).toBeLessThan(enqueueOrder);
    expect(commitCorrectionBump.mock.invocationCallOrder[0]).toBeLessThan(markOrder);
  });

  it("surfaces markNeedsCheck failure after source bump already committed", async () => {
    const commitCorrectionBump = vi.fn(async () => 2);
    const markNeedsCheckForSources = vi.fn(async () => {
      throw new Error("knowledge mark failed");
    });
    const enqueueRebuild = vi.fn(async () => ({
      jobId: "rebuild-job",
      kind: "build-course-knowledge" as const,
      created: true,
    }));
    const { service, createOnce } = makeService({
      commitCorrectionBump,
      markNeedsCheckForSources,
      enqueueRebuild,
    });
    await expect(service.applyCorrections(principal, sourceId, correctionBody)).rejects.toThrow(
      /knowledge mark failed/,
    );
    expect(commitCorrectionBump).toHaveBeenCalledOnce();
    expect(markNeedsCheckForSources).toHaveBeenCalledOnce();
    expect(enqueueRebuild).not.toHaveBeenCalled();
    // Job receipt must not run if knowledge mark fails (source already consistent at bumped).
    expect(createOnce).not.toHaveBeenCalled();
  });

  it("swallows enqueueRebuild failure without rolling back bump or skipping job receipt", async () => {
    const commitCorrectionBump = vi.fn(async () => 2);
    const enqueueRebuild = vi.fn(async () => {
      throw new Error("rebuild enqueue failed");
    });
    const { service, markNeedsCheckForSources, createOnce, claim, finish } = makeService({
      commitCorrectionBump,
      enqueueRebuild,
    });
    const result = await service.applyCorrections(principal, sourceId, correctionBody);
    expect(result).toEqual({ jobId });
    expect(commitCorrectionBump).toHaveBeenCalledOnce();
    expect(markNeedsCheckForSources).toHaveBeenCalledOnce();
    // Both courses attempted; failures swallowed (best-effort).
    expect(enqueueRebuild).toHaveBeenCalledTimes(2);
    expect(createOnce).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });
});
