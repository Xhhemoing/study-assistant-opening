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

const model = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("./model-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-gateway")>();
  const { createModelGateway } = await import("@aistudy/ai");
  return {
    ...actual,
    createDbModelGateway: () => createModelGateway({
      resolve: async () => ({
        provider: model,
        modelSnapshot: { id: "teach-model", providerId: "p", modelName: "real-model", inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
        inputCentsPerMillion: 1,
        outputCentsPerMillion: 1,
      }),
    }),
  };
});

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
  model.complete.mockImplementation(async (input: { text: string }) => modelAnswer(input));
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

/** What a real model returns: grounded blocks when evidence was supplied, uncited otherwise. */
function modelAnswer(input: { text: string }, options: { formula?: boolean } = {}) {
  const grounded = input.text.includes(CHUNK);
  const cite = grounded ? [CHUNK] : [];
  return {
    text: JSON.stringify({
      itemTitles: ["秩与零空间：从例子看起", "观察", "定义", "例题", "检查"],
      blocks: [
        { type: "text", text: grounded ? "矩阵的秩与零空间维数之和等于列数，这就是秩—零化度定理。" : "秩与零空间的关系可以从线性方程组的解来理解。", citedChunkIds: cite },
        ...(options.formula === false ? [] : [{ type: "formula", text: "\\operatorname{rank}(A) + \\dim N(A) = n", citedChunkIds: cite }]),
        { type: "prompt", text: "一个 3×5 矩阵的秩为 2，零空间维数是多少？", citedChunkIds: [] },
        { type: "answer_key", text: "5 − 2 = 3", citedChunkIds: [] },
      ],
    }),
    citedChunkIds: [], requestId: "req-1", candidates: [], inputTokens: 100, outputTokens: 100,
  };
}

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
    // The routed model writes the blocks; the learner's intent and evidence reach the prompt.
    expect(JSON.stringify(writtenBlocks)).toContain("秩—零化度定理");
    expect(spec.generationConfig?.extras).toMatchObject({ contentSource: "model" });
    const sent = model.complete.mock.calls[0]![0] as { text: string; outputFormat?: string };
    expect(sent.outputFormat).toBe("json");
    expect(sent.text).toContain("学习意图：秩与零空间");
    expect(sent.text).toContain(CHUNK);
    // Formulas cannot be text-matched against evidence, so they never carry a citation.
    expect(writtenBlocks.find((b) => b.type === "formula")!.content).toEqual({ latex: "\\operatorname{rank}(A) + \\dim N(A) = n" });
    const answerKey = writtenBlocks.find((b) => b.type === "answer_key")!;
    expect(answerKey.content).toMatchObject({ answer: "5 − 2 = 3", hidden: true });
    expect(result).toMatchObject({ generateStatus: "needs_check" });
    expect(statuses).toEqual(["generating", "needs_check"]);
  });

  it("with validation on, blocks quoting cited evidence verify and the activity reaches ready", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "1");
    // An uncited formula is an unchecked claim (no formula tool), so the verified path has none.
    model.complete.mockImplementation(async (input: { text: string }) => modelAnswer(input, { formula: false }));
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

  it("records the call in the ledger under the teaching.compile route", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    const deps = shared();
    const run = createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, deps));
    await run(job, payload);
    expect(deps.budget.reserve).toHaveBeenCalledWith(scope, expect.objectContaining({
      purpose: "compile-teaching-unit",
      requestId: `compile-teaching-unit:${job.id}`,
      modelSnapshot: expect.objectContaining({ id: "teach-model" }),
    }));
    expect(deps.budget.settle).toHaveBeenCalledTimes(1);
  });

  it("an unusable model answer fails the job instead of publishing template filler", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    model.complete.mockResolvedValue({ text: JSON.stringify({ blocks: [{ type: "html", text: "<b>x</b>" }] }), citedChunkIds: [], requestId: null, candidates: [], inputTokens: 1, outputTokens: 1 });
    const run = createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()));
    await expect(run(job, payload)).rejects.toThrow(/no teaching block/);
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
