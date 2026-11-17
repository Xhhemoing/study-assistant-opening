import { expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
const pinSpy = vi.hoisted(() => ({ readMaterialPurposePin: vi.fn() }));
vi.mock("./opening-course-ready-sources", async importOriginal => {
  const actual = await importOriginal<typeof import("./opening-course-ready-sources")>();
  return {
    ...actual,
    createOpeningCourseReadySourcesRepository: (sql: Sql) => {
      const real = actual.createOpeningCourseReadySourcesRepository(sql);
      return {
        ...real,
        readMaterialPurposePin: (...args: Parameters<typeof real.readMaterialPurposePin>) => {
          pinSpy.readMaterialPurposePin(...args);
          return real.readMaterialPurposePin(...args);
        },
      };
    },
  };
});
import { assertTeachingExampleDoesNotRepeatPrompt, createOpeningTeachingExamplesRepository, teachingExampleJobPayloadSchema } from "./opening-teaching-examples";
const id = "11111111-1111-4111-8111-111111111111";
const payload = { mode: "example", request: { clientKey: "example-01", target: { activityId: id, documentId: id, revisionNumber: 1, contentVersion: 1, blockId: id }, consentVersion: "teaching-example-paid-v1", acceptPaidGeneration: true },
  originalExample: "求导数 x²，得2x。", sourceRefs: [{ sourceId: id, version: 1 }], activitySourceIds: [], blocks: [], blockOrder: [],
  purposePin: { courseId: null, materialUse: "teaching", sources: [] }, estimatedCents: 1 };
it.each(["text", "markdown", "prompt", "question"] as const)("refuses normalized exact current prompt %s without revealing hidden keys", field => {
  const blocks = [{ id, type: "question", content: { [field]: " 求 $\\int x^3 dx$。 " } }];
  const order = [{ blockId: id, position: 0, role: "prompt" as const, blockType: "question" }];
  expect(() => assertTeachingExampleDoesNotRepeatPrompt("求$\\int x^3 dx$。", blocks, order)).toThrow("当前练习题");
});
it.each([
  { interaction: { kind: "choice", options: [{ id: "A", label: "１" }, { id: "B", label: "２" }] }, problem: "计算极限。 A. 1 B. 2" },
  { interaction: { kind: "numeric", unit: "米" }, problem: "计算极限。 单位：米" },
])("refuses exact rendered options/unit identity as well as the unchanged body", ({ interaction, problem }) => {
  const blocks = [{ id, type: "prompt", content: { text: "计算极限。", interaction } }];
  const order = [{ blockId: id, position: 0, role: "teach" as const, blockType: "prompt" }];
  expect(() => assertTeachingExampleDoesNotRepeatPrompt(problem, blocks, order)).toThrow("当前练习题");
  expect(() => assertTeachingExampleDoesNotRepeatPrompt("计算极限。", blocks, order)).toThrow("当前练习题");
});
it("only matches current published prompts, not hidden answers, unbound blocks or semantic guesses", () => {
  const blocks = [{ id, type: "prompt", content: { text: "求极限 sin x/x。" } },
    { id: "hidden", type: "answer_key", content: { answer: "hidden-private-key" } },
    { id: "unbound", type: "prompt", content: { text: "unpublished" } }];
  const order = [{ blockId: id, position: 0, role: "prompt" as const, blockType: "prompt" },
    { blockId: "hidden", position: 1, role: "answer_key" as const, blockType: "answer_key" }];
  for (const problem of ["hidden-private-key", "unpublished", "求极限 sin(2x)/x。", "换一种说法求上述极限。"])
    expect(() => assertTeachingExampleDoesNotRepeatPrompt(problem, blocks, order)).not.toThrow();
});
it("keeps the example operation outside legacy whole-lesson cancellation/reconcile fields", () => {
  const parsed = teachingExampleJobPayloadSchema.parse(payload);
  expect(parsed.request.target.activityId).toBe(id);
  expect("activityId" in parsed).toBe(false); expect("expectedContentVersion" in parsed).toBe(false);
  expect(teachingExampleJobPayloadSchema.safeParse({ ...payload, activityId: id }).success).toBe(false);
  expect(teachingExampleJobPayloadSchema.safeParse({ ...payload, expectedContentVersion: 1 }).success).toBe(false);
});
it("rejects malformed discriminants, absent source pins and client-supplied extra context", () => {
  for (const change of [{ mode: "generate" }, { sourceRefs: [] }, { estimatedCents: -1 }, { originalExample: "" }, { hiddenAnswers: ["secret"] }]) {
    expect(teachingExampleJobPayloadSchema.safeParse({ ...payload, ...change }).success).toBe(false);
  }
});
it("reuses the outer transaction in context() instead of opening a nested sql.begin", async () => {
  pinSpy.readMaterialPurposePin.mockClear();
  const membershipId = "22222222-2222-4222-8222-222222222222";
  const scope = { workspaceId: id, ownerUserId: id };
  const target = { activityId: id, documentId: id, revisionNumber: 1, contentVersion: 1, blockId: id };
  const blocks = [{ id, type: "example", content: { text: payload.originalExample } }];
  const order = [{ blockId: id, position: 0, role: "example", blockType: "example" }];
  const refs = [{ sourceId: id, version: 1 }];
  let inOuterTx = false;
  let capturedTx: TransactionSql | undefined;
  const txFn = (async (parts: TemplateStringsArray) => {
    const q = parts.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("FOR UPDATE OF") || q.startsWith("FOR SHARE OF")) return [];
    if (q.includes("SELECT id FROM workspaces") || q.includes("SELECT id FROM users") || q.includes("SELECT id FROM courses")) return [{ id }];
    if (q.includes("SELECT s.*,r.blocks")) {
      return [{ id, teaching_unit_id: id, blocks, block_order: order, source_refs: refs, source_ids: [id],
        content_version: 1, version: 1, revision_number: 1, current_revision_number: 1, status: "active", generate_status: "idle", course_id: id }];
    }
    if (q.includes("SELECT course_id,goal_json,create_intent FROM opening_teaching_activities")) {
      return [{ course_id: id, goal_json: {}, create_intent: {} }];
    }
    if (q.includes("SELECT s.id FROM opening_sources")) return [{ id }];
    if (q.includes("SELECT s.id,s.version FROM opening_sources")) return [{ id, version: 1 }];
    if (q.includes("FROM course_asset_memberships")) {
      return [{ id: membershipId, asset_id: id, purpose: "teaching", purpose_revision: "2026-11-17T00:00:00.000000Z" }];
    }
    throw new Error("unhandled SQL double: " + q);
  }) as unknown as TransactionSql;
  const begin = vi.fn(async (fn: (tx: TransactionSql) => Promise<unknown>) => {
    if (inOuterTx) throw new Error("nested transaction pool deadlock");
    inOuterTx = true;
    capturedTx = txFn;
    try { return await fn(txFn); } finally { inOuterTx = false; }
  });
  const sql = Object.assign(() => { throw new Error("outer sql must not be called during context()"); }, { begin }) as unknown as Sql;
  const result = await createOpeningTeachingExamplesRepository(sql).context(scope, target);
  expect(begin).toHaveBeenCalledTimes(1);
  expect(pinSpy.readMaterialPurposePin).toHaveBeenCalledTimes(1);
  expect(pinSpy.readMaterialPurposePin).toHaveBeenCalledWith(scope, { courseId: id, sourceIds: [id], materialUse: "teaching" }, capturedTx);
  expect(result.purposePin).toEqual({
    courseId: id,
    materialUse: "teaching",
    sources: [{ sourceId: id, sourceVersion: 1, membershipId, purposeRevision: "2026-11-17T00:00:00.000000Z", purpose: "teaching" }],
  });
});
