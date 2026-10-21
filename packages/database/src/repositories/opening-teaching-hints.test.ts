import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { teachingHintResponseSchema } from "@aistudy/contracts";

const exposure = vi.hoisted(() => ({ generate: vi.fn(), release: vi.fn() }));
vi.mock("./opening-study-exposure", () => ({ generateOpeningStudyExposure: exposure.generate, releaseOpeningStudyExposure: exposure.release }));
import { createOpeningTeachingHintRepository, readOpeningTeachingAnswerKey } from "./opening-teaching-hints";

const id = "11111111-1111-4111-8111-111111111111", blockId = "22222222-2222-4222-8222-222222222222", answerId = "33333333-3333-4333-8333-333333333333";
const scope = { workspaceId: id, ownerUserId: id };
const hints = { direction: "检查线性约束。", concept: "秩是线性无关列的数量。", firstStep: "把第一列写作一个列向量。" };
const now = "2026-10-21T00:00:00.000Z";
function database(options: { submitted?: boolean; version?: number; sourceVersion?: number; missing?: boolean; hints?: unknown; answer?: string | null } = {}) {
  const queries: string[] = [];
  const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?"); queries.push(query);
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id }]);
    if (query.includes("FROM opening_learning_attempts")) return Promise.resolve(options.missing ? [] : [{ id, activity_id: id, course_id: id, session_id: id, item_version_id: id,
      submitted_at: options.submitted ? now : null, source_versions: { [id]: 1 }, create_intent: { teachingBlock: { blockId, contentVersion: 1 } } }]);
    if (query.includes("FROM opening_teaching_activities")) return Promise.resolve([{ content_version: options.version ?? 1, source_ids: [id] }]);
    if (query.includes("FROM opening_sources")) return Promise.resolve([{ id, version: options.sourceVersion ?? 1 }]);
    if (query.includes("FROM opening_teaching_activity_specs")) return Promise.resolve([{ version: 1, document_id: id, revision_number: 1,
      block_order: [{ blockId, blockType: "prompt", role: "prompt", position: 0 }, { blockId: answerId, blockType: "answer_key", role: "answer_key", position: 1 }],
      source_refs: [{ sourceId: id, version: 1 }] }]);
    if (query.includes("FROM library_revisions")) return Promise.resolve([{ blocks: [{ id: answerId, content: { answer: options.answer === undefined ? "完整解答" : options.answer,
      hints: Object.hasOwn(options, "hints") ? options.hints : hints } }] }]);
    return Promise.resolve([]);
  }) as unknown as Sql;
  sql.begin = ((fn: (tx: Sql) => unknown) => fn(sql)) as Sql["begin"];
  return { sql, queries };
}
beforeEach(() => {
  vi.clearAllMocks();
  exposure.generate.mockImplementation(async (_tx, _scope, input) => ({ id, ...input }));
  exposure.release.mockImplementation(async () => {
    const input = exposure.generate.mock.lastCall![2];
    return { id, releaseKey: input.releaseKey, contextAnchor: input.contextAnchor, origin: input.origin, supportDomain: input.supportDomain,
      generatedAt: now, releasedAt: now, acknowledgedAt: null, historyRevision: 1 };
  });
});

describe("teaching hint delivery", () => {
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
});
