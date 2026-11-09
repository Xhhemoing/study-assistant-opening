import { expect, it } from "vitest";
import { spanRepairContextSchema, spanRepairIssueInputSchema, spanRepairPlanSchema, spanRepairPresentationInputSchema } from "./span-repair";
const id = "11111111-1111-4111-8111-111111111111";
const prerequisite = { status: "unknown", reasonCode: "prerequisite_binding_missing" };
const basis = { observationId: id, rootObservationId: id, attemptId: id, problemId: id, itemVersionId: id,
  sourceRefs: [{ sourceId: id, sourceVersion: 1 }], evaluatorVersion: "span-exact-v1", specVersion: "span-v1" };
const plan = { version: 1, contentVersion: 1, status: "ready", basis, targetSkill: "coefficients",
  diagnosticBasis: "first_verified_dependency_step", prerequisite,
  teachingExample: { problemId: "example", version: "1" }, practiceVariant: { problemId: "variant", version: "1" }, returnMoveId: "self_study-reserved" };
it("parses strict v1 plans and rejects unknown versions, extra authority and premature confirmation identity", () => {
  expect(spanRepairPlanSchema.parse(plan)).toEqual(plan);
  expect(spanRepairPlanSchema.safeParse({ ...plan, version: 2 }).success).toBe(false);
  expect(spanRepairPlanSchema.safeParse({ ...plan, confirmation: { problemId: "future", version: "1" } }).success).toBe(false);
  expect(spanRepairPlanSchema.safeParse({ ...plan, prerequisite: { status: "verified_weak" } }).success).toBe(false);
  expect(spanRepairPlanSchema.safeParse({ ...plan, basis: { ...basis, evaluatorVersion: "model" } }).success).toBe(false);
  expect(spanRepairPlanSchema.parse({ version: 1, contentVersion: 1, status: "needs_clarification", reasonCode: "predecessor_unobserved", prerequisite })).toMatchObject({ status: "needs_clarification" });
});
it("accepts client activity/version/stage/key only, never chosen targets or frozen specs", () => {
  const presentation = { activityId: id, repairVersion: 1, stage: "example", clientKey: "request-1" };
  expect(spanRepairPresentationInputSchema.safeParse(presentation).success).toBe(true);
  expect(spanRepairPresentationInputSchema.safeParse({ ...presentation, targetSkill: "equation" }).success).toBe(false);
  const issue = { activityId: id, repairVersion: 1, expectedRevision: 1, stage: "confirmation", clientKey: "request-2" };
  expect(spanRepairIssueInputSchema.safeParse(issue).success).toBe(true);
  expect(spanRepairIssueInputSchema.safeParse({ ...issue, problemId: "future" }).success).toBe(false);
  expect(spanRepairIssueInputSchema.safeParse({ ...issue, spanExercise: {} }).success).toBe(false);
});
it("allows only an explicit variant retry parent and still rejects client evaluation authority", () => {
  const request = { activityId: id, repairVersion: 1, expectedRevision: 1, stage: "variant", clientKey: "retry-request", retryAfterAttemptId: id };
  expect(spanRepairIssueInputSchema.parse(request)).toEqual(request);
  for (const extra of [{ stage: "confirmation" }, { retryAfterAttemptId: "bad-id" }, { correct: true }, { serverEvaluation: {} }, { targetSkill: "equation" }]) {
    expect(spanRepairIssueInputSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  }
});
it("public context rejects private plan identities and never labels external prerequisites verified", () => {
  const context = { status: "ready", version: 1, contentVersion: 1, targetSkill: "coefficients", focusSummary: "本题步骤", prerequisiteStatus: "unknown" };
  expect(spanRepairContextSchema.safeParse(context).success).toBe(true);
  expect(spanRepairContextSchema.safeParse({ ...context, teachingExample: plan.teachingExample }).success).toBe(false);
  expect(spanRepairContextSchema.safeParse({ ...context, prerequisiteStatus: "verified_weak" }).success).toBe(false);
});
