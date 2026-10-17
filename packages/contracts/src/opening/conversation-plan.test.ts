import { describe, expect, it } from "vitest";
import { conversationPlanInputSchema, conversationPlanMetadataSchema } from "./conversation-plan";
const id = "11111111-1111-4111-8111-111111111111";
const input = { candidateId: id, expectedVersion: 0, date: "2026-10-16", expectedAcceptedVersion: 1, clientKey: "request-0001" };
describe("conversation plan boundary", () => {
  it("distinguishes a missing course choice from an explicit no-course choice", () => {
    expect(conversationPlanInputSchema.parse(input).courseId).toBeUndefined();
    expect(conversationPlanInputSchema.parse({ ...input, courseId: null }).courseId).toBeNull();
  });
  it.each([{ title: "forged" }, { sourceTurnId: id }, { origin: "agent" }, { minutes: 241 }, { minutes: 0 }])("rejects client-forged metadata and invalid duration %j", extra => {
    expect(conversationPlanInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });
  it("requires a complete bounded server projection rather than trusting a candidate ID alone", () => {
    expect(conversationPlanMetadataSchema.safeParse({ candidateId: id }).success).toBe(false);
    expect(conversationPlanMetadataSchema.parse({ kind: "conversation_plan_v1", candidateId: id, expectedCandidateVersion: 0,
      sourceTurnId: id, sourceIds: [], taskId: id, title: "练习", minutes: 20, courseId: null, dueText: "下周" }).dueText).toBe("下周");
  });
});
