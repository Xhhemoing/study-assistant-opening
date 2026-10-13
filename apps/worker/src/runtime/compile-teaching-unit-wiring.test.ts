import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySpecPublishInput, SourceChunk } from "@aistudy/contracts";
import type { OpeningJobRecord } from "@aistudy/database";

const activities = vi.hoisted(() => ({
  get: vi.fn(),
  setGenerateStatus: vi.fn(),
}));
const content = vi.hoisted(() => ({
  createUnit: vi.fn(),
  getUnit: vi.fn(),
  writeUnitBlocks: vi.fn(),
  readRevision: vi.fn(),
  publishActivitySpec: vi.fn(),
}));

vi.mock("@aistudy/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aistudy/database")>()),
  createOpeningTeachingActivitiesRepository: () => activities,
  createOpeningTeachingContentRepository: () => content,
}));

import { createCompileTeachingUnitHandler } from "../jobs/compile-teaching-unit";
import { createCompileTeachingUnitWorkerDeps } from "./compile-teaching-unit-wiring";

const ACTIVITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const UNIT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const DOC = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const SOURCE = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const CHUNK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const scope = { workspaceId: "ffffffff-ffff-4fff-8fff-fffffffffff1", ownerUserId: "ffffffff-ffff-4fff-8fff-fffffffffff2" };

const chunk: SourceChunk = {
  id: CHUNK,
  sourceId: SOURCE,
  sourceVersion: 1,
  page: 1,
  slideLabel: null,
  startMs: null,
  endMs: null,
  text: "矩阵的秩与零空间维数之和等于列数，这就是秩—零化度定理。",
  imageObjectKey: null,
};

const job: OpeningJobRecord = {
  id: "99999999-9999-4999-8999-999999999991",
  workspaceId: scope.workspaceId,
  ownerUserId: scope.ownerUserId,
  key: `compile-teaching-unit:${ACTIVITY}:generate:today-topic:2026-10-13`,
  kind: "compile-teaching-unit",
  payload: {},
  result: null,
  state: "running",
  privacyEpoch: 0,
};

function shared() {
  const reservation = { id: "res-1", workspaceId: scope.workspaceId, purpose: "compile-teaching-unit", amountCents: 100, requestId: "r", state: "reserved", modelSnapshot: null };
  return {
    budget: {
      reserve: vi.fn(async () => reservation),
      release: vi.fn(async () => ({ ...reservation, state: "released" })),
      claimExecution: vi.fn(async () => true),
      settle: vi.fn(async () => ({ ...reservation, state: "completed" })),
      markUnknown: vi.fn(async () => reservation),
    },
    chunks: { listForSources: vi.fn(async () => [chunk]) },
    privacy: { getWorkspaceEpoch: vi.fn(async () => 0), listExcludedSourceIds: vi.fn(async () => []) },
  } as unknown as Parameters<typeof createCompileTeachingUnitWorkerDeps>[1];
}

/** getJobState reads opening_jobs directly; the job is always running here. */
const jobStateSql = (async () => [{ state: "running" }]) as unknown as Parameters<typeof createCompileTeachingUnitWorkerDeps>[0];

let statuses: string[];
let writtenBlocks: Array<{ id: string; type: string; content: Record<string, unknown> }>;
let published: ActivitySpecPublishInput[];

beforeEach(() => {
  vi.clearAllMocks();
  statuses = [];
  writtenBlocks = [];
  published = [];
  activities.get.mockResolvedValue({ id: ACTIVITY, intentSummary: "秩与零空间", intentKind: "material", generateStatus: "queued" });
  activities.setGenerateStatus.mockImplementation(async (_s: unknown, _a: unknown, status: string) => {
    statuses.push(status);
    return true;
  });
  content.createUnit.mockResolvedValue({ id: UNIT, documentId: DOC, currentRevisionNumber: 1 });
  content.getUnit.mockResolvedValue({ id: UNIT, documentId: DOC, currentRevisionNumber: 2 });
  content.writeUnitBlocks.mockImplementation(async (_s: unknown, _u: unknown, blocks: typeof writtenBlocks) => {
    writtenBlocks = blocks;
    return { documentId: DOC, revisionNumber: 2 };
  });
  content.readRevision.mockImplementation(async () => ({
    blocks: writtenBlocks.map((b, position) => ({ ...b, position })),
  }));
  content.publishActivitySpec.mockImplementation(async (_s: unknown, input: ActivitySpecPublishInput) => {
    published.push(input);
    return { id: "spec-1" };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const payload = {
  mode: "generate" as const,
  activityId: ACTIVITY,
  expectedContentVersion: 0,
  clientKey: "today-topic:2026-10-13",
  sourceIds: [SOURCE],
};

describe("compile-teaching-unit worker wiring (compiler on)", () => {
  it("creates the unit, writes compiled blocks as a new revision and publishes that revision", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    const run = createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()));
    const result = await run(job, payload);

    expect(content.createUnit).toHaveBeenCalledWith(scope, expect.objectContaining({
      blocks: [expect.objectContaining({ type: "meta" })],
    }));
    expect(content.writeUnitBlocks).toHaveBeenCalledWith(scope, UNIT, expect.any(Array));
    expect(writtenBlocks.length).toBeGreaterThan(0);
    expect(published).toHaveLength(1);
    const spec = published[0]!;
    expect(spec.revisionNumber).toBe(2);
    expect(spec.blockOrder.map((ref) => ref.blockId)).toEqual(writtenBlocks.map((b) => b.id));
    expect(spec.generationConfig?.extras).not.toHaveProperty("stub");
    // Learner's intent drives the outline, not the provider stub text.
    expect(JSON.stringify(writtenBlocks)).toContain("秩与零空间");
    expect(result).toMatchObject({ generateStatus: "needs_check" });
    expect(statuses).toEqual(["generating", "needs_check"]);
  });

  it("with validation on, blocks quoting cited evidence verify and the activity reaches ready", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "1");
    const run = createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()));
    const result = await run(job, payload);

    const teach = writtenBlocks.find((b) => b.type === "text")!;
    expect(teach.content.citedChunkIds).toEqual([CHUNK]);
    expect(content.readRevision).toHaveBeenCalledWith(scope, DOC, 2);
    expect(result).toMatchObject({ generateStatus: "ready", verificationStatus: "verified" });
    expect(statuses).toEqual(["generating", "needs_check", "ready"]);
    expect(published.map((p) => p.verificationStatus)).toEqual(["needs_check", "verified"]);
  });

  it("without materials the result stays needs_check — never ready without checked content", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "1");
    const deps = shared();
    (deps.chunks.listForSources as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const run = createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, deps));
    const result = await run(job, { ...payload, sourceIds: [] });

    expect(published.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ generateStatus: "needs_check" });
    expect(statuses).not.toContain("ready");
  });

  it("a failed block write fails the job and marks the activity failed (no publish)", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    content.writeUnitBlocks.mockRejectedValue(new Error("document revision conflict"));
    const run = createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()));
    await expect(run(job, payload)).rejects.toThrow("document revision conflict");
    expect(published).toEqual([]);
    expect(statuses).toEqual(["generating", "failed"]);
  });

  it("budget exceeded fails soft: activity failed, nothing published", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    const deps = shared();
    const { OpeningBudgetError } = await import("@aistudy/database");
    (deps.budget.reserve as ReturnType<typeof vi.fn>).mockRejectedValue(
      new OpeningBudgetError("BUDGET_EXCEEDED", "daily workspace budget exceeded"),
    );
    const run = createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, deps));
    await expect(run(job, payload)).rejects.toThrow();
    expect(published).toEqual([]);
    expect(content.writeUnitBlocks).not.toHaveBeenCalled();
    expect(statuses).toEqual(["generating", "failed"]);
  });
});
