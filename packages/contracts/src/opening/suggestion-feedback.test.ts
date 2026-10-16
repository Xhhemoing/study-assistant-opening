import { expect, it } from "vitest";
import { suggestionFeedbackInputSchema } from "./suggestion-feedback";
const input = { draftId: "00000000-0000-4000-8000-000000000001", expectedDraftVersion: 0,
  suggestionKey: "planner:2026-10-16:review_cards:none:none", clientKey: "feedback-one" };
it("accepts optional reasons while rejecting client-controlled ownership or learning metadata", () => {
  expect(suggestionFeedbackInputSchema.parse(input)).toEqual(input);
  expect(suggestionFeedbackInputSchema.safeParse({ ...input, reason: "too_hard" }).success).toBe(true);
  for (const extra of [{ courseId: input.draftId }, { requirementKey: "prove" }, { identity: "invented" },
    { ownerUserId: input.draftId }, { reason: "free text" }, { expectedDraftVersion: -1 }]) {
    expect(suggestionFeedbackInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  }
});
