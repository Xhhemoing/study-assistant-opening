import { describe, expect, it } from "vitest";
import {
  answerRuleSchema,
  publicPracticeItemSchema,
  startPracticeRequestSchema,
  startPracticeResponseSchema,
} from "./practice-content";

const itemId = "11111111-1111-4111-8111-111111111111";
const syllabusPointId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const attackerWorkspaceId = "44444444-4444-4444-8444-444444444444";
const attackerUserId = "55555555-5555-4555-8555-555555555555";

const publicItem = {
  id: itemId,
  contentVersion: 2,
  syllabusPointId,
  kind: "multiple_choice" as const,
  stem: "导数的定义是什么？",
  options: ["极限", "积分"],
  abilitySlice: "recognition" as const,
  estimatedMinutes: 5,
  availableHintCount: 1,
};

describe("practice content contracts", () => {
  it("rejects answer and answerRule on a public practice item", () => {
    expect(publicPracticeItemSchema.parse(publicItem).id).toBe(itemId);
    expect(publicPracticeItemSchema.safeParse({ ...publicItem, answer: "极限" }).success).toBe(false);
    expect(
      publicPracticeItemSchema.safeParse({
        ...publicItem,
        answerRule: { type: "exact", accepted: ["极限"] },
      }).success,
    ).toBe(false);
  });

  it("normalizes non-empty accepted answers on answer rules", () => {
    expect(
      answerRuleSchema.parse({ type: "exact", accepted: [" 极限 ", "导数"] }),
    ).toEqual({ type: "exact", accepted: ["极限", "导数"] });
    expect(
      answerRuleSchema.parse({
        type: "token_set",
        accepted: [[" 列式 ", "求解"], ["0", "2"]],
      }),
    ).toEqual({
      type: "token_set",
      accepted: [["列式", "求解"], ["0", "2"]],
    });
    expect(answerRuleSchema.safeParse({ type: "exact", accepted: ["", "  "] }).success).toBe(false);
    expect(answerRuleSchema.safeParse({ type: "token_set", accepted: [[]] }).success).toBe(false);
  });

  it("keeps practice session start free of request-chosen workspace or user identity", () => {
    expect(
      startPracticeRequestSchema.safeParse({
        practiceItemId: itemId,
        workspaceId: attackerWorkspaceId,
        ownerUserId: attackerUserId,
      }).success,
    ).toBe(false);

    const response = startPracticeResponseSchema.parse({
      sessionId,
      item: publicItem,
    });
    expect(response).toEqual({ sessionId, item: publicItem });
    expect(startPracticeResponseSchema.safeParse({
      sessionId,
      item: publicItem,
      workspaceId: attackerWorkspaceId,
      ownerUserId: attackerUserId,
    }).success).toBe(false);
  });
});
