import { expect, it } from "vitest";
import { localReplanInputSchema } from "./local-replan";
import { coachPlanUndoInputSchema } from "./coach-plans";
import { conversationPlanInputSchema } from "./conversation-plan";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
it.each(["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-01"])("rejects invalid calendar day %s before DB casts", date => {
  expect(localReplanInputSchema.safeParse({ date, expectedAcceptedVersion: 1, clientKey: "replan-test" }).success).toBe(false);
  expect(coachPlanUndoInputSchema.safeParse({ date, acceptanceClientKey: "coach-key", expectedAcceptedVersion: 1, clientKey: "undo-test" }).success).toBe(false);
  expect(conversationPlanInputSchema.safeParse({ candidateId: id, expectedVersion: 0, date, expectedAcceptedVersion: 0, clientKey: "conversation-test" }).success).toBe(false);
});
it("accepts a leap day and rejects client-owned blocks or fixed exemptions", () => {
  const value = { date: "2028-02-29", expectedAcceptedVersion: 1, clientKey: "replan-test" };
  expect(localReplanInputSchema.parse(value)).toEqual(value);
  expect(localReplanInputSchema.safeParse({ ...value, blocks: [], fixedBlocks: [] }).success).toBe(false);
  expect(localReplanInputSchema.safeParse({ ...value, allowOtherDay: true, free: [] }).success).toBe(false);
});
