import { expect, it } from "vitest";
import { learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema } from "./learning-attempts";
const sessionId = "11111111-1111-4111-8111-111111111111";
it("allows an unlinked server-issued attempt without inventing a problem", () => {
  expect(learningAttemptCreateInputSchema.parse({ sessionId, clientKey: "start-001" })).toEqual({ sessionId, clientKey: "start-001" });
});
it.each(["attemptId", "startedAt", "itemVersionId", "sourceVersions", "eligibility"])("rejects client-owned derived or identity field %s", (key) => {
  expect(learningAttemptCreateInputSchema.safeParse({ sessionId, clientKey: "start-001", [key]: "forged" }).success).toBe(false);
});
it("rejects client submitted server time and qualification", () => {
  const input = { clientKey: "submit-001", answer: "answer", outcome: "correct", assistance: "independent" };
  expect(learningAttemptSubmitInputSchema.safeParse(input).success).toBe(true);
  expect(learningAttemptSubmitInputSchema.safeParse({ ...input, submittedAt: "2026-09-28T00:00:00Z" }).success).toBe(false);
  expect(learningAttemptSubmitInputSchema.safeParse({ ...input, eligibility: { verifiedCorrect: "yes" } }).success).toBe(false);
});
