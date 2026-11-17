import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { teachingHintResponseSchema } from "@aistudy/contracts";

const exposure = vi.hoisted(() => ({ generate: vi.fn(), release: vi.fn() }));
const examOrigin = vi.hoisted(() => ({
  assertCurrent: vi.fn(),
  impl: null as null | typeof import("./opening-course-exam-origin").assertOpeningCourseExamSourceCurrent,
}));
vi.mock("./opening-study-exposure", async original => ({ ...await original<typeof import("./opening-study-exposure")>(), generateOpeningStudyExposure: exposure.generate, releaseOpeningStudyExposure: exposure.release }));
vi.mock("./opening-course-exam-origin", async original => {
  const actual = await original<typeof import("./opening-course-exam-origin")>();
  examOrigin.impl = actual.assertOpeningCourseExamSourceCurrent;
  examOrigin.assertCurrent.mockImplementation(actual.assertOpeningCourseExamSourceCurrent);
  return { ...actual, assertOpeningCourseExamSourceCurrent: examOrigin.assertCurrent };
});
import { createOpeningTeachingHintRepository, readOpeningTeachingAnswerKey } from "./opening-teaching-hints";

const id = "11111111-1111-4111-8111-111111111111", blockId = "22222222-2222-4222-8222-222222222222", answerId = "33333333-3333-4333-8333-333333333333";
const chunkId = "44444444-4444-4444-8444-444444444444", requestId = "55555555-5555-4555-8555-555555555555";
const scope = { workspaceId: id, ownerUserId: id };
const hints = { direction: "检查线性约束。", concept: "秩是线性无关列的数量。", firstStep: "把第一列写作一个列向量。" };
const now = "2026-10-21T00:00:00.000Z";
function database(options: {
  submitted?: boolean; version?: number; sourceVersion?: number; missing?: boolean; hints?: unknown; answer?: string | null;
  releasedRows?: Record<string, unknown>[]; courseId?: string | null; purpose?: "teaching" | "practice" | "mock_exam" | "reference" | null;
  memberships?: Array<{ asset_id: string; purpose: string | null }>; sourceIds?: string[]; sourceRefs?: Array<{ sourceId: string; version: number }>;
  clientKey?: string; examOnlyOrigin?: boolean; examSourceCurrent?: boolean; examChunksCurrent?: boolean;
} = {}) {
  const queries: string[] = [];
  const sourceIds = options.sourceIds ?? [id];
  const sourceRefs = options.sourceRefs ?? [{ sourceId: id, version: 1 }];
  const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?"); queries.push(query);
    if (query.includes("FROM opening_exam_sprints")) {
      if (!options.examOnlyOrigin) return Promise.resolve([]);
      return Promise.resolve([{
        course_id: id,
        activity_id: id,
        activity_course_id: id,
        pack_snapshot: {
          format: "course-exam-v1",
          requests: [{
            id: requestId,
            input: { clientKey: "course-exam-req-1", sourceId: id, questionCount: 3 },
            sourceVersion: 1,
            sourceTitle: "期末模拟卷",
            referenceMode: "exam-only",
            privacyEpoch: 0,
            createdAt: now,
            status: "ready",
            proposal: {
              title: "线性代数模拟练习",
              topics: [{ label: "矩阵秩", evidenceChunkIds: [chunkId] }],
              questions: [1, 2, 3].map(index => ({
                topic: "矩阵秩",
                prompt: `第${index}题：计算二阶单位矩阵的秩并说明理由。`,
                referenceAnswer: "两列线性无关，因此秩等于2。",
                rubric: ["秩等于2"],
                hints,
                evidenceChunkIds: [chunkId],
                estimatedMinutes: 5,
              })),
            },
            activityId: id,
            modelLabel: "fixture",
          }],
        },
      }]);
    }
    if (query.includes("FROM courses c")) return Promise.resolve(options.examSourceCurrent === false ? [] : [{ id }]);
    if (query.includes("FROM opening_source_chunks\n")) return Promise.resolve(options.examChunksCurrent === false ? [] : [{ id: chunkId }]);
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id }]);
    if (query.includes("FROM opening_help_exposures")) return Promise.resolve(options.releasedRows ?? []);
    if (query.includes("FROM opening_learning_attempts")) return Promise.resolve(options.missing ? [] : [{ id, activity_id: id, course_id: id, session_id: id, item_version_id: id,
      submitted_at: options.submitted ? now : null, source_versions: Object.fromEntries(sourceIds.map(sid => [sid, 1])), create_intent: { teachingBlock: { blockId, contentVersion: 1 } } }]);
    if (query.includes("FROM opening_teaching_activities")) return Promise.resolve([{
      client_key: options.clientKey ?? id, content_version: options.version ?? 1, course_id: options.courseId === undefined ? id : options.courseId, source_ids: sourceIds,
    }]);
    if (query.includes("FROM opening_sources")) return Promise.resolve(sourceIds.map(sid => ({ id: sid, version: options.sourceVersion ?? 1 })));
    if (query.includes("FROM course_asset_memberships")) return Promise.resolve(
      options.memberships ?? sourceIds.map(sid => ({ asset_id: sid, purpose: options.purpose === undefined ? null : options.purpose })),
    );
    if (query.includes("FROM opening_teaching_activity_specs")) return Promise.resolve([{ version: 1, document_id: id, revision_number: 1,
      block_order: [{ blockId, blockType: "prompt", role: "prompt", position: 0 }, { blockId: answerId, blockType: "answer_key", role: "answer_key", position: 1 }],
      source_refs: sourceRefs }]);
    if (query.includes("FROM library_revisions")) return Promise.resolve([{ blocks: [{ id: answerId, content: { answer: options.answer === undefined ? "完整解答" : options.answer,
      hints: Object.hasOwn(options, "hints") ? options.hints : hints } }] }]);
    return Promise.resolve([]);
  }) as unknown as Sql;
  sql.begin = ((fn: (tx: Sql) => unknown) => fn(sql)) as Sql["begin"];
  return { sql, queries };
}
beforeEach(() => {
  vi.clearAllMocks();
  if (examOrigin.impl) examOrigin.assertCurrent.mockImplementation(examOrigin.impl);
  exposure.generate.mockImplementation(async (_tx, _scope, input) => ({ id, ...input }));
  exposure.release.mockImplementation(async () => {
    const input = exposure.generate.mock.lastCall![2];
    return { id, releaseKey: input.releaseKey, contextAnchor: input.contextAnchor, origin: input.origin, supportDomain: input.supportDomain,
      generatedAt: now, releasedAt: now, acknowledgedAt: null, historyRevision: 1 };
  });
});

describe("teaching hint delivery", () => {
  function releasedRow(level: 1 | 4) {
    return { id, release_key: `teaching-hint-v1:${id}:${level}`, context_anchor: { attemptId: id, courseId: id, itemVersionId: id, activityId: id, blockId, contentVersion: 1, purpose: level === 4 ? "history_solution" : "learning_help" },
      exposure_origin: level === 4 ? "history_solution" : "assistant", kind: level === 4 ? "solution" : "hint", level: level === 4 ? "revealed" : "hinted", support_domain: "unknown", generated_at: now, released_at: now, acknowledged_at: null, history_revision: 1 };
  }
  it("reads only the previously released stages and their original receipts without mutating history", async () => {
    const { sql, queries } = database({ releasedRows: [releasedRow(1), releasedRow(4)] });
    const result = await createOpeningTeachingHintRepository(sql).readReleased(scope, { attemptId: id });
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ level: 1, text: hints.direction, exposureReceipt: { id, releasedAt: now, historyRevision: 1 } });
    expect(JSON.stringify(result)).not.toContain("完整解答");
    expect(queries.some(query => /INSERT|UPDATE|DELETE/.test(query))).toBe(false);
    expect(exposure.generate).not.toHaveBeenCalled(); expect(exposure.release).not.toHaveBeenCalled();
    expect(await createOpeningTeachingHintRepository(database({ submitted: true, releasedRows: [releasedRow(4)] }).sql).readReleased(scope, { attemptId: id })).toMatchObject([{ level: 4, text: "完整解答" }]);
    expect(await createOpeningTeachingHintRepository(database().sql).readReleased(scope, { attemptId: id })).toEqual([]);
  });
  it.each([{ version: 2 }, { sourceVersion: 2 }, { missing: true }])("refuses stale or unavailable attempts on recovery", async options => {
    await expect(createOpeningTeachingHintRepository(database(options).sql).readReleased(scope, { attemptId: id })).rejects.toBeTruthy();
    expect(exposure.generate).not.toHaveBeenCalled(); expect(exposure.release).not.toHaveBeenCalled();
  });
  it("does not return a release whose anchor belongs to another question", async () => {
    const row = releasedRow(1); row.context_anchor = { ...row.context_anchor, blockId: answerId };
    await expect(createOpeningTeachingHintRepository(database({ releasedRows: [row] }).sql).readReleased(scope, { attemptId: id })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it.each([1, 2, 3] as const)("releases only stored stage %s before submission with a real current-attempt receipt", async level => {
    const { sql, queries } = database();
    const response = await createOpeningTeachingHintRepository(sql).read(scope, { attemptId: id, level });
    expect(teachingHintResponseSchema.parse(response)).toEqual(response);
    expect(response.text).toBe([hints.direction, hints.concept, hints.firstStep][level - 1]);
    expect(response.referenceSourceId).toBeNull();
    expect(JSON.stringify(response)).not.toContain("完整解答");
    expect(exposure.generate).toHaveBeenCalledWith(sql, scope, expect.objectContaining({ releaseKey: `teaching-hint-v1:${id}:${level}`,
      contextAnchor: { courseId: id, activityId: id, blockId, contentVersion: 1, attemptId: id, itemVersionId: id, purpose: "learning_help" },
      sessionId: id, supportDomain: "unknown", kind: "hint", level: "hinted", origin: "assistant" }));
    expect(queries.findIndex(query => query.includes("opening_workspace_history_revisions"))).toBeLessThan(queries.findIndex(query => query.includes("FROM opening_learning_attempts")));
  });
  it("refuses level four before submission without recording an exposure", async () => {
    await expect(createOpeningTeachingHintRepository(database().sql).read(scope, { attemptId: id, level: 4 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(exposure.generate).not.toHaveBeenCalled();
  });
  it("shares the sealed solution and release identity with legacy answer-key reads", async () => {
    const { sql } = database({ submitted: true });
    const result = await createOpeningTeachingHintRepository(sql).read(scope, { attemptId: id, level: 4 });
    expect(result).toMatchObject({ text: "完整解答", exposureReceipt: { releaseKey: `teaching-hint-v1:${id}:4`, origin: "history_solution", contextAnchor: { purpose: "history_solution" } } });
    await sql.begin(tx => readOpeningTeachingAnswerKey(tx, scope, id, blockId, id));
    expect(exposure.generate.mock.calls[0]![2]).toEqual(exposure.generate.mock.calls[1]![2]);
  });
  it.each([{ version: 2 }, { sourceVersion: 2 }, { hints: undefined }, { hints: { ...hints, firstStep: "" } }])("does not deliver stale or invented hint content %s", async options => {
    await expect(createOpeningTeachingHintRepository(database(options).sql).read(scope, { attemptId: id, level: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(exposure.generate).not.toHaveBeenCalled();
  });
  it("does not manufacture a full answer or unlock another prompt", async () => {
    await expect(createOpeningTeachingHintRepository(database({ submitted: true, answer: null }).sql).read(scope, { attemptId: id, level: 4 })).rejects.toMatchObject({ code: "CONFLICT" });
    const { sql } = database({ submitted: true });
    await expect(sql.begin(tx => readOpeningTeachingAnswerKey(tx, scope, id, answerId, id))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createOpeningTeachingHintRepository(database({ missing: true }).sql).read(scope, { attemptId: id, level: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(exposure.generate).not.toHaveBeenCalled();
  });
  it.each(["mock_exam", "reference"] as const)("blocks %s materials on hint read, level 4, answer key, and released replay", async purpose => {
    const db = database({ submitted: true, purpose, releasedRows: [releasedRow(1), releasedRow(4)] });
    const repo = createOpeningTeachingHintRepository(db.sql);
    await expect(repo.read(scope, { attemptId: id, level: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.read(scope, { attemptId: id, level: 4 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.readReleased(scope, { attemptId: id })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(db.sql.begin(tx => readOpeningTeachingAnswerKey(tx, scope, id, blockId, id))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(exposure.generate).not.toHaveBeenCalled();
  });
  it("blocks unlinked course sources and allows practice/teaching/null or exam-only empty source refs", async () => {
    await expect(createOpeningTeachingHintRepository(database({ memberships: [] }).sql).read(scope, { attemptId: id, level: 1 }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    for (const purpose of [null, "teaching", "practice"] as const) {
      await expect(createOpeningTeachingHintRepository(database({ submitted: true, purpose }).sql).read(scope, { attemptId: id, level: 4 }))
        .resolves.toMatchObject({ text: "完整解答" });
    }
    const examOnly = database({ submitted: true, sourceIds: [], sourceRefs: [] });
    await expect(createOpeningTeachingHintRepository(examOnly.sql).read(scope, { attemptId: id, level: 4 }))
      .resolves.toMatchObject({ text: "完整解答" });
    expect(examOnly.queries.some(query => query.includes("course_asset_memberships"))).toBe(false);
  });
  it("checks exam-only course-exam origin with forwarded readOnly and fails closed across all readers when unavailable", async () => {
    const clientKey = `course-exam:${requestId}`;
    const current = database({ submitted: true, sourceIds: [], sourceRefs: [], releasedRows: [releasedRow(1), releasedRow(4)], clientKey, examOnlyOrigin: true });
    const repo = createOpeningTeachingHintRepository(current.sql);
    for (const level of [1, 2, 3, 4] as const) {
      await expect(repo.read(scope, { attemptId: id, level })).resolves.toMatchObject({ level });
      expect(examOrigin.assertCurrent).toHaveBeenLastCalledWith(current.sql, scope, { id, clientKey }, { readOnly: false });
    }
    expect(current.queries).toContain("FOR SHARE OF c,w,m,s,v");
    await expect(current.sql.begin(tx => readOpeningTeachingAnswerKey(tx, scope, id, blockId, id))).resolves.toMatchObject({ answer: "完整解答" });
    expect(examOrigin.assertCurrent).toHaveBeenLastCalledWith(current.sql, scope, { id, clientKey }, { readOnly: false });

    const readonly = database({ submitted: true, sourceIds: [], sourceRefs: [], releasedRows: [releasedRow(1), releasedRow(4)], clientKey, examOnlyOrigin: true });
    await expect(createOpeningTeachingHintRepository(readonly.sql).readReleased(scope, { attemptId: id })).resolves.toHaveLength(2);
    expect(examOrigin.assertCurrent).toHaveBeenLastCalledWith(readonly.sql, scope, { id, clientKey }, { readOnly: true });
    expect(readonly.queries).not.toContain("FOR SHARE OF c,w,m,s,v");

    for (const patch of [{ examSourceCurrent: false }, { examChunksCurrent: false }] as const) {
      vi.clearAllMocks();
      const broken = database({ submitted: true, sourceIds: [], sourceRefs: [], releasedRows: [releasedRow(1), releasedRow(4)], clientKey, examOnlyOrigin: true, ...patch });
      const brokenRepo = createOpeningTeachingHintRepository(broken.sql);
      for (const level of [1, 2, 3, 4] as const) {
        await expect(brokenRepo.read(scope, { attemptId: id, level })).rejects.toMatchObject({ code: "CONFLICT" });
      }
      await expect(brokenRepo.readReleased(scope, { attemptId: id })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(broken.sql.begin(tx => readOpeningTeachingAnswerKey(tx, scope, id, blockId, id))).rejects.toMatchObject({ code: "CONFLICT" });
      expect(exposure.generate).not.toHaveBeenCalled();
      expect(exposure.release).not.toHaveBeenCalled();
    }
  });
});
