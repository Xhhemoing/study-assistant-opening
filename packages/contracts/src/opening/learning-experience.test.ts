import { expect, it } from "vitest";
import { learningExperienceInputSchema } from "./learning-experience";
const id = "11111111-1111-4111-8111-111111111111";

it("accepts first-render observation metadata but never client-authored server stages", () => {
  const input = { kind: "first_text", jobId: id, clientKey: "submit", durationMs: 2345, executionId: id, observedAt: "2026-10-26T12:00:00.000Z" };
  expect(learningExperienceInputSchema.parse(input)).toEqual(input);
  expect(learningExperienceInputSchema.safeParse({ ...input, kind: "tutor_claimed" }).success).toBe(false);
  expect(learningExperienceInputSchema.safeParse({ ...input, executionId: "not-an-id" }).success).toBe(false);
});
