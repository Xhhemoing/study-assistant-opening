import { rankPedagogy } from "../../../../tests/fixtures/opening/teaching/rank-pedagogy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySpecPublishInput, SourceChunk, TeachingLearnerFocus, TeachingPartialHints } from "@aistudy/contracts";
import type { OpeningJobRecord } from "@aistudy/database";

const activities = vi.hoisted(() => ({
  get: vi.fn(),
  setGenerateStatus: vi.fn(),
}));
const content = vi.hoisted(() => ({
  createUnit: vi.fn(),
  getActivitySpec: vi.fn(),
  getUnit: vi.fn(),
  writeUnitBlocks: vi.fn(),
  readRevision: vi.fn(),
  publishActivitySpec: vi.fn(),
  validateActivitySourceRefs: vi.fn(),
}));

const model = vi.hoisted(() => ({ complete: vi.fn(), task: vi.fn() }));
const readFocus = vi.hoisted(() => vi.fn());
vi.mock("./model-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-gateway")>();
  const { createModelGateway } = await import("@aistudy/ai");
  return {
    ...actual,
    createDbModelGateway: () => createModelGateway({
      resolve: async (_scope, task) => { model.task(task); return ({
        provider: model,
        modelSnapshot: { id: "teach-model", providerId: "p", modelName: "real-model", inputCentsPerMillion: 1, outputCentsPerMillion: 1,
          mediaInputTokenUpperBound: 1000, mediaMaxInputBytes: 1024, mediaInputCentsPerMillion: 1 },
        inputCentsPerMillion: 1,
        outputCentsPerMillion: 1,
        supportsVision: true, mediaInputTokenUpperBound: 1000, mediaMaxInputBytes: 1024, mediaInputCentsPerMillion: 1,
      }); },
    }),
  };
});

vi.mock("@aistudy/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aistudy/database")>()),
  createOpeningTeachingActivitiesRepository: () => activities,
  createOpeningTeachingContentRepository: () => content,
  readOpeningTeachingCompilerFocus: readFocus,
  assertOpeningCourseRouteReady: vi.fn(async () => {}),
  readOpeningCourseRouteEvidenceRefs: vi.fn(async () => null),
  createOpeningSourceEmbeddingsRepository: () => ({
    authorizeChunks: async (_scope: unknown, chunks: SourceChunk[]) => ({ chunks, privacyEpoch: 0 }),
    hasIndex: async () => false,
  }),
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
  readFocus.mockResolvedValue({});
  content.getActivitySpec.mockResolvedValue(null);
  content.validateActivitySourceRefs.mockResolvedValue(undefined);
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

const rankHints: TeachingPartialHints = {
  direction: "先找矩阵的列数与秩，再联系零空间维数。",
  concept: "秩与零空间维数的和等于矩阵的列数。",
  firstStep: "将已知列数 5 和秩 2 代入 rank(A) + dim N(A) = 5，先写出等式。",
};

/** What a real model returns: grounded blocks when evidence was supplied, uncited otherwise. */
function modelAnswer(input: { text: string; chunks?: SourceChunk[] }, options: { formula?: boolean } = {}) {
  const grounded = input.text.includes(CHUNK) || input.chunks?.some(chunk => chunk.id === CHUNK);
  const cite = grounded ? [CHUNK] : [];
  return {
    text: JSON.stringify({
      itemTitles: ["秩与零空间：从例子看起", "观察", "定义", "例题", "检查"],
      blocks: [
        { type: "text", text: grounded ? "矩阵的秩与零空间维数之和等于列数，这就是秩—零化度定理。" : "秩与零空间的关系可以从线性方程组的解来理解。", citedChunkIds: cite },
        ...(options.formula === false ? [] : [{ type: "formula", text: "\\operatorname{rank}(A) + \\dim N(A) = n", citedChunkIds: cite }]),
        { type: "prompt", text: "一个 3×5 矩阵的秩为 2，零空间维数是多少？", citedChunkIds: [] },
        { type: "answer_key", ...rankPedagogy, text: "5 − 2 = 3", hints: rankHints, citedChunkIds: [] },
        ...(!input.text.includes('"prerequisiteRepair"') ? [
          { type: "text", text: "现在改变列数，检查自由变量是否随之变化。", citedChunkIds: cite },
          { type: "prompt", text: "一个 3×4 矩阵的秩为 2，零空间维数是多少？" },
          { type: "answer_key", ...rankPedagogy, text: "4 − 2 = 2", hints: rankHints },
        ] : []),
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
  it.each([undefined, "0"])("keeps formula validation disabled for flag %s", (flag) => {
    vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", flag);
    vi.stubEnv("TEACHING_VALIDATION_ENABLED", undefined);
    expect(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()).verifyAfterPublish).toBeUndefined();
  });

  it("configures post-publish validation only when enabled", () => {
    vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "1");
    expect(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()).verifyAfterPublish).toBeTypeOf("function");
  });

  it("injects the actual page loader and uses the visual task only for image-bearing compilation", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    const dependencies = shared();
    dependencies.chunks.listForSources = vi.fn(async () => [{ ...chunk, imageObjectKey: "owned/page1" }]);
    const pageImages = vi.fn(async () => [{ sourceId: SOURCE, physicalPage: 1, mediaType: "image/png" as const, data: "data:image/png;base64,AA==" }]);
    const run = createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, { ...dependencies, pageImages }));
    await run(job, payload);
    expect(pageImages).toHaveBeenCalledWith(scope, { sourceIds: [SOURCE], sourceVersions: { [SOURCE]: 1 }, physicalPage: 1 });
    expect(model.task).toHaveBeenCalledWith("teaching.compile-visual");
    expect(model.complete.mock.calls[0]![0]).toMatchObject({ mediaCapability: "text_plus_page_images", imageParts: [expect.objectContaining({ sourceId: SOURCE, physicalPage: 1 })] });
  });

  it("does not spend or publish an empty lesson when the operator disables compilation", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "0");
    const dependencies = shared();
    const deps = createCompileTeachingUnitWorkerDeps(jobStateSql, dependencies);
    await expect(createCompileTeachingUnitHandler(deps)(job, payload)).rejects.toThrow("AI 主讲当前已关闭");
    expect(model.complete).not.toHaveBeenCalled();
    expect(dependencies.budget.reserve).not.toHaveBeenCalled();
    expect(content.createUnit).not.toHaveBeenCalled();
    expect(content.publishActivitySpec).not.toHaveBeenCalled();
    expect(activities.setGenerateStatus).toHaveBeenCalledWith(expect.anything(), ACTIVITY, "failed", expect.anything());
  });

  it("enforces the persisted prerequisite prompt boundary at actual publication even after revalidation removes the prelude", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    const learnerFocus: TeachingLearnerFocus = { skillLabel: "秩与零空间", activityKind: "diagnose", reasonCode: "no_evidence",
      focusObservationId: null, recentAssistance: [], strategyVersion: "adaptive-goal-1",
      goalContext: { mode: "exam", reasonCode: "selected_exam", targetDate: null, daysRemaining: null, priority: 0, prerequisiteBudgetMinutes: 5 },
      prerequisiteRepair: { nodeId: SOURCE, targetNodeId: CHUNK, skillLabel: "线性方程组", returnToSkillLabel: "秩与零空间", maxMinutes: 5,
        reason: "近期错误", stopCondition: "关键步骤完成后返回原题" },
    };
    activities.get.mockResolvedValue({ id: ACTIVITY, intentSummary: "秩与零空间", intentKind: "material", generateStatus: "queued", learnerFocus });
    const { prerequisiteRepair: _repair, ...current } = learnerFocus;
    readFocus.mockResolvedValue({ learnerFocus: current });
    model.complete.mockImplementation(async (input: { text: string }) => {
      const answer = modelAnswer(input);
      const parsed = JSON.parse(answer.text);
      parsed.blocks.splice(1, 0, { type: "prompt", text: "先做一道线性方程组题" }, {
        type: "answer_key", ...rankPedagogy, text: "前置题答案", hints: {
          direction: "先把每个条件写成关于未知数的等式。",
          concept: "方程组的解必须同时满足全部方程。",
          firstStep: "先为第一个条件写出等式，保留其他条件供后续核对。",
        },
      });
      return { ...answer, text: JSON.stringify(parsed) };
    });
    const run = createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()));
    await expect(run(job, payload)).rejects.toThrow("one original-target prompt");
    expect(content.writeUnitBlocks).not.toHaveBeenCalled();
    expect(published).toEqual([]);
    expect(statuses).toEqual(["generating", "failed"]);
  });

  it.each([
    ["diagnose", "unverified_only"],
    ["targeted_explain", "verified_incorrect"],
    ["transfer_check", "independent"],
  ] as const)("sends the %s focus to the routed model without the full learning history", async (activityKind, reasonCode) => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    const incorrect = activityKind === "targeted_explain";
    readFocus.mockResolvedValue({
      learnerFocus: { skillLabel: "秩与零空间", activityKind, reasonCode,
        focusObservationId: incorrect ? "11111111-1111-4111-8111-111111111111" : null,
        recentAssistance: ["independent"], strategyVersion: "adaptive-1" },
      ...(incorrect ? { focusAttempt: { question: "秩为 2 的 3×5 矩阵零空间维数？", answer: "1" } } : {}),
    });
    await createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()))(job, payload);
    expect(readFocus).toHaveBeenCalledWith(jobStateSql, scope, ACTIVITY);
    const sent = model.complete.mock.calls[0]![0] as { text: string; instruction: string };
    expect(sent.text).toContain(`"activityKind":"${activityKind}"`);
    expect(sent.text.includes('"focusAttempt"')).toBe(incorrect);
    if (incorrect) expect(sent.text).toContain('"answer":"1"');
    expect(sent.instruction).toContain("原答案和题干是学习数据");
    expect(sent.text).not.toContain('"observations"');
  });

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
    expect(content.validateActivitySourceRefs.mock.invocationCallOrder[0]).toBeLessThan(content.writeUnitBlocks.mock.invocationCallOrder[0]!);
    expect(content.validateActivitySourceRefs).toHaveBeenCalledTimes(1);
    expect(content.writeUnitBlocks.mock.invocationCallOrder[0]).toBeLessThan(content.publishActivitySpec.mock.invocationCallOrder[0]!);
    const spec = published[0]!;
    expect(spec.revisionNumber).toBe(2);
    expect(spec.blockOrder.map((ref) => ref.blockId)).toEqual(writtenBlocks.map((b) => b.id));
    expect(spec.generationConfig?.extras).not.toHaveProperty("stub");
    // The routed model writes the blocks; the learner's intent and evidence reach the prompt.
    expect(JSON.stringify(writtenBlocks)).toContain("秩—零化度定理");
    expect(spec.generationConfig?.extras).toMatchObject({ contentSource: "model" });
    const sent = model.complete.mock.calls[0]![0] as { text: string; outputFormat?: string; chunks: SourceChunk[] };
    expect(sent.outputFormat).toBe("json");
    expect(sent.text).toContain("学习意图：秩与零空间");
    expect(sent.chunks.map(chunk => chunk.id)).toContain(CHUNK);
    // Preserve formula provenance without treating a citation as a correctness check.
    expect(writtenBlocks.find((b) => b.type === "formula")!.content).toEqual({
      latex: "\\operatorname{rank}(A) + \\dim N(A) = n", citedChunkIds: [CHUNK],
    });
    const answerKey = writtenBlocks.find((b) => b.type === "answer_key")!;
    expect(answerKey.content).toMatchObject({ answer: "5 − 2 = 3", hints: rankHints, hidden: true });
    expect(answerKey.content).not.toHaveProperty("citedChunkIds");
    expect(writtenBlocks.find((b) => b.type === "prompt")!.content).not.toHaveProperty("hints");
    expect(result).toMatchObject({ generateStatus: "needs_check" });
    expect(statuses).toEqual(["generating", "needs_check"]);
  });

  it.each(["0", "1"])("runs one preflight plus authoritative publication with real repository lock queries (validation flag %s)", async flag => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", flag);
    // Only SQL I/O is synthetic here: run the real repository validation,
    // transaction boundaries and locks rather than counting a mocked validator.
    const queries: Array<{ transaction: number; query: string }> = [];
    let transaction = 0;
    const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
      if (!Object.hasOwn(strings, "raw")) return strings;
      const query = (strings as TemplateStringsArray).join("?");
      queries.push({ transaction, query });
      if (query.includes("FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId }]);
      if (query.includes("FROM opening_jobs")) return Promise.resolve([{ state: "running" }]);
      if (query.includes("FROM opening_teaching_activities")) return Promise.resolve([{ id: ACTIVITY, content_version: 0 }]);
      if (query.includes("FROM opening_teaching_units")) return Promise.resolve([{ id: UNIT, document_id: DOC }]);
      if (query.includes("FROM opening_sources")) return Promise.resolve([{ id: SOURCE, version: 1 }]);
      if (query.includes("FROM opening_source_versions")) return Promise.resolve([{ version: 1, availability: "available" }]);
      if (query.includes("FROM opening_source_chunks")) return Promise.resolve([{ id: CHUNK, source_version: 1 }]);
      if (query.includes("INSERT INTO opening_teaching_activity_specs")) return Promise.resolve([{
        id: "spec-1", activity_id: ACTIVITY, teaching_unit_id: UNIT, document_id: DOC,
        revision_number: 2, block_order: values[7], source_refs: values[8], version: 1,
      }]);
      if (query.includes("UPDATE opening_teaching_activities")) return Promise.resolve([{ id: ACTIVITY }]);
      return Promise.resolve([]);
    }) as unknown as Parameters<typeof createCompileTeachingUnitWorkerDeps>[0];
    sql.begin = vi.fn(async callback => { transaction++; return callback(sql); }) as unknown as typeof sql.begin;
    sql.json = ((value: unknown) => value) as typeof sql.json;
    const { createOpeningTeachingContentRepository } = await import("../../../../packages/database/src/repositories/opening-teaching-content");
    const repository = createOpeningTeachingContentRepository(sql);
    content.validateActivitySourceRefs.mockImplementation(repository.validateActivitySourceRefs);
    content.publishActivitySpec.mockImplementation(repository.publishActivitySpec);
    const dependencies = shared();
    const deps = createCompileTeachingUnitWorkerDeps(sql, dependencies);
    // Exercise the optional verifier once without an extra metadata publication.
    const verify = vi.fn(async () => null);
    deps.verifyAfterPublish = verify;
    await createCompileTeachingUnitHandler(deps)(job, payload);

    expect(content.validateActivitySourceRefs).toHaveBeenCalledTimes(1);
    expect(content.publishActivitySpec).toHaveBeenCalledTimes(1);
    expect(sql.begin).toHaveBeenCalledTimes(2);
    const historyLocks = queries.filter(({ query }) => query.includes("SELECT revision FROM opening_workspace_history_revisions") && query.includes("FOR UPDATE"));
    expect(historyLocks.map(({ transaction }) => transaction)).toEqual([1, 2]);
    const sourceLocks = queries.filter(({ query }) => query.includes("FROM opening_sources") && query.includes("FOR SHARE"));
    expect(sourceLocks.map(({ transaction }) => transaction)).toEqual([1, 2]);
    const versionLocks = queries.filter(({ query }) => query.includes("FROM opening_source_versions") && query.includes("FOR SHARE"));
    const chunkLocks = queries.filter(({ query }) => query.includes("FROM opening_source_chunks") && query.includes("FOR SHARE"));
    expect(versionLocks.map(({ transaction }) => transaction)).toEqual([1, 2]);
    expect(chunkLocks.map(({ transaction }) => transaction)).toEqual([1, 2]);
    const routeChecks = queries.filter(({ query }) => query.includes("SELECT course_id,goal_json,create_intent FROM opening_teaching_activities"));
    expect(routeChecks.map(({ transaction }) => transaction)).toEqual([1, 2]);
    expect(content.validateActivitySourceRefs.mock.invocationCallOrder[0]).toBeLessThan(content.writeUnitBlocks.mock.invocationCallOrder[0]!);
    expect(content.writeUnitBlocks.mock.invocationCallOrder[0]).toBeLessThan(content.publishActivitySpec.mock.invocationCallOrder[0]!);
    expect(verify).toHaveBeenCalledTimes(flag === "1" ? 1 : 0);
    expect(dependencies.budget.reserve).toHaveBeenCalledTimes(1);
    expect(dependencies.budget.settle).toHaveBeenCalledTimes(1);
  });

  it.each(["0", "1"])("rejects invalid source ownership before saving bodies or publishing (validation flag %s)", async (flag) => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", flag);
    const error = Object.assign(new Error("source ref is unavailable in this workspace"), { code: "VALIDATION" });
    content.validateActivitySourceRefs.mockRejectedValue(error);
    const run = createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()));
    await expect(run(job, payload)).rejects.toBe(error);
    expect(content.validateActivitySourceRefs).toHaveBeenCalledWith(scope, expect.objectContaining({
      activityId: ACTIVITY, sourceRefs: [{ sourceId: SOURCE, version: 1, page: 1, chunkId: CHUNK }],
    }));
    expect(content.writeUnitBlocks).not.toHaveBeenCalled();
    expect(content.publishActivitySpec).not.toHaveBeenCalled();
    expect(statuses).toEqual(["generating", "failed"]);
  });

  it("preflights custom publish builders before calling the repository publish path", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    const deps = createCompileTeachingUnitWorkerDeps(jobStateSql, shared());
    deps.buildPublishInput = async () => ({ activityId: ACTIVITY, teachingUnitId: UNIT, expectedVersion: 0,
      revisionNumber: 2, blockOrder: [], sourceRefs: [{ sourceId: SOURCE, version: 1, chunkId: "invented" }] });
    content.validateActivitySourceRefs.mockRejectedValue(Object.assign(new Error("invalid chunk"), { code: "VALIDATION" }));
    await expect(createCompileTeachingUnitHandler(deps)(job, payload)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(content.validateActivitySourceRefs).toHaveBeenCalledTimes(1);
    expect(content.publishActivitySpec).not.toHaveBeenCalled();
    expect(statuses).toEqual(["generating", "failed"]);
  });

  it("publication still rejects refs invalidated after a successful preflight", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    content.publishActivitySpec.mockRejectedValue(Object.assign(new Error("source ref version no longer exists"), { code: "CONFLICT" }));
    await expect(createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()))(job, payload))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(content.validateActivitySourceRefs).toHaveBeenCalledTimes(1);
    expect(published).toEqual([]);
    expect(statuses).toEqual(["generating", "failed"]);
  });

  it("validation publishes cited teaching as a draft without upgrading the unchecked answer key", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "1");
    // Even with no formula to check, quoting material cannot verify a generated answer key.
    model.complete.mockImplementation(async (input: { text: string }) => modelAnswer(input, { formula: false }));
    const run = createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()));
    const result = await run(job, payload);

    const teach = writtenBlocks.find((b) => b.type === "text")!;
    expect(teach.content.citedChunkIds).toEqual([CHUNK]);
    expect(content.readRevision).toHaveBeenCalledWith(scope, DOC, 2);
    expect(result).toMatchObject({
      generateStatus: "needs_check", verificationStatus: "structure_ok",
      validationReport: {
        structurePassed: true, factPassed: false,
        presentation: { kind: "discussion_draft", allowsFormalScoring: false },
      },
    });
    expect(statuses).toEqual(["generating", "needs_check"]);
    expect(published.map((p) => p.verificationStatus)).toEqual(["needs_check", "structure_ok"]);
    // The published graph and learner prompt remain available for studying.
    expect(published[1]?.blockOrder.map((ref) => ref.blockId)).toEqual(writtenBlocks.map((block) => block.id));
    expect(writtenBlocks.find((block) => block.type === "prompt")?.content.text).toContain("零空间维数是多少");
  });

  it("keeps unknown symbolic formula verification as needs_check after valid source preflight", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "1");
    const result = await createCompileTeachingUnitHandler(createCompileTeachingUnitWorkerDeps(jobStateSql, shared()))(job, payload);
    expect(result).toMatchObject({ generateStatus: "needs_check", verificationStatus: "needs_check",
      validationReport: { factPassed: false, layers: expect.arrayContaining([
        expect.objectContaining({ layer: "source_identity", outcome: "pass" }),
        expect.objectContaining({ layer: "tool_result", outcome: "unknown" }),
      ]) } });
    expect(statuses).not.toContain("ready");
    expect(published.map(spec => spec.verificationStatus)).toEqual(["needs_check", "needs_check"]);
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
