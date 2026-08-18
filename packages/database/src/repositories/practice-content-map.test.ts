import { describe, expect, it } from "vitest";
import { mapGradableItem, mapPublicItem, mapSession } from "./practice-content-types";

const itemId = "11111111-1111-4111-8111-111111111111";
const pointId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const ownerUserId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";

const versionRow = {
  practice_item_id: itemId,
  version: 2,
  syllabus_point_id: pointId,
  kind: "short_answer",
  stem: "导数的定义是什么？",
  options: null,
  answer_rule: { type: "exact", accepted: ["极限"] },
  answer_display: "极限",
  hints: ["回到增量比"],
  ability_slice: "recall",
  estimated_minutes: 5,
};

describe("practice content mappers", () => {
  it("omits answer and answerRule from the public item", () => {
    const item = mapPublicItem(versionRow);
    expect(item).toEqual({
      id: itemId,
      contentVersion: 2,
      syllabusPointId: pointId,
      kind: "short_answer",
      stem: "导数的定义是什么？",
      abilitySlice: "recall",
      estimatedMinutes: 5,
      availableHintCount: 1,
    });
    expect(item).not.toHaveProperty("answer");
    expect(item).not.toHaveProperty("answerRule");
  });

  it("keeps the server answer rule on a gradable version", () => {
    const item = mapGradableItem(versionRow);
    expect(item.answerRule).toEqual({ type: "exact", accepted: ["极限"] });
    expect(item.answerDisplay).toBe("极限");
    expect(item.hints).toEqual(["回到增量比"]);
  });

  it("maps a principal-bound session without request identity fields", () => {
    const session = mapSession({
      id: sessionId,
      workspace_id: workspaceId,
      owner_user_id: ownerUserId,
      practice_item_id: itemId,
      content_version: 2,
      started_at: "2026-08-15T03:00:00.000Z",
      hint_count: 0,
      answer_revealed_at: null,
      submitted_at: null,
    });
    expect(session).toMatchObject({
      id: sessionId,
      workspaceId,
      ownerUserId,
      practiceItemId: itemId,
      contentVersion: 2,
      hintCount: 0,
      answerRevealedAt: null,
      submittedAt: null,
    });
  });
});
