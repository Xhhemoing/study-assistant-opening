import { expect, it } from "vitest";
import { teachingExampleJobPayloadSchema } from "./opening-teaching-examples";
const id = "11111111-1111-4111-8111-111111111111";
const payload = { mode: "example", request: { clientKey: "example-01", target: { activityId: id, documentId: id, revisionNumber: 1, contentVersion: 1, blockId: id }, consentVersion: "teaching-example-paid-v1", acceptPaidGeneration: true },
  originalExample: "求导数 x²，得2x。", sourceRefs: [{ sourceId: id, version: 1 }], activitySourceIds: [], blocks: [], blockOrder: [],
  purposePin: { courseId: null, materialUse: "teaching", sources: [] }, estimatedCents: 1 };
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
