import { expect, it } from "vitest";
import { assertTeachingExampleDoesNotRepeatPrompt, teachingExampleJobPayloadSchema } from "./opening-teaching-examples";
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
