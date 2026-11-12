import { expect, it } from "vitest";
import { teachingExampleRequestSchema, teachingExampleStatusSchema, teachingExampleProposalSchema, TEACHING_EXAMPLE_CONSENT_VERSION } from "./teaching-example";
const id = "11111111-1111-4111-8111-111111111111";
const target = { activityId: id, documentId: id, revisionNumber: 1, blockId: id, contentVersion: 2 };
const request = { clientKey: "example-01", target, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, acceptPaidGeneration: true };
it("accepts explicit consent and rejects client content, operation and prices", () => {
  expect(teachingExampleRequestSchema.parse(request)).toEqual(request);
  for (const extra of [{ prompt: "injected" }, { answer: "1" }, { price: 0 }, { operationId: id }, { acceptPaidGeneration: false }, { consentVersion: "old" }]) {
    expect(teachingExampleRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  }
  expect(teachingExampleRequestSchema.safeParse({ ...request, target: { ...target, prompt: "client stem" } }).success).toBe(false);
});
it("only a durable publication permits succeeded and never leaks bodies", () => {
  const status = { operationId: id, clientKey: request.clientKey, target, state: "queued", estimatedCents: 1, estimateIsCap: false, costState: "unsent", publication: null, createdAt: "2026-11-10T15:00:00.000Z" };
  expect(teachingExampleStatusSchema.safeParse(status).success).toBe(true);
  expect(teachingExampleStatusSchema.safeParse({ ...status, state: "succeeded" }).success).toBe(false);
  const publication = { documentId: id, revisionNumber: 2, contentVersion: 3, exampleBlockId: id, solutionBlockId: id, mathematicalStatus: "unchecked", assistance: "revealed", masteryEvidence: false };
  expect(teachingExampleStatusSchema.safeParse({ ...status, state: "succeeded", publication }).success).toBe(true);
  expect(teachingExampleStatusSchema.safeParse({ ...status, publication }).success).toBe(false);
  expect(teachingExampleStatusSchema.safeParse({ ...status, answer: "hidden" }).success).toBe(false);
});
it.each(["", "\u0000", "<script>alert(1)</script>", "[open](https://example.test)", "\\href{evil}{click}", "![image]", "javascript:alert(1)"])("rejects unsafe or empty model text %j", text => {
  expect(teachingExampleProposalSchema.safeParse({ problem: text, workedSolution: "计算得到1" }).success).toBe(false);
});
it("allows mathematical comparisons and LaTeX without treating them as HTML", () => {
  expect(teachingExampleProposalSchema.safeParse({ problem: "当 x < 0 时，求 $\\int x^2 dx$。", workedSolution: "$x^3/3+C$，求导核对。" }).success).toBe(true);
});
