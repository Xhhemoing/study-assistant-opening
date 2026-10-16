import { expect, it } from "vitest";
import { coachPlanAcceptInputSchema, coachPlanUndoInputSchema } from "./coach-plans";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
it("keeps coach selection, budget and acceptance source server-owned", () => {
  const input = { draftId: id, expectedDraftVersion: 0, clientKey: "coach:explicit" };
  expect(coachPlanAcceptInputSchema.parse(input)).toEqual(input);
  for (const field of ["budgetMinutes", "acceptSuggestedKeys", "origin", "source"]) {
    expect(coachPlanAcceptInputSchema.safeParse({ ...input, [field]: "forged" }).success).toBe(false);
  }
});
it("requires the specific accepted version for undo and rejects impossible dates", () => {
  const input = { date: "2026-10-21", acceptanceClientKey: "coach:explicit", expectedAcceptedVersion: 1, clientKey: "undo:explicit" };
  expect(coachPlanUndoInputSchema.parse(input)).toEqual(input);
  expect(coachPlanUndoInputSchema.safeParse({ ...input, expectedAcceptedVersion: 0 }).success).toBe(false);
  expect(coachPlanUndoInputSchema.safeParse({ ...input, date: "2026-02-30" }).success).toBe(false);
});
