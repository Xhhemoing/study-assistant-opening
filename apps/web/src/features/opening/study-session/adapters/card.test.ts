import { expect, it } from "vitest";
import type { ReviewQueueItem } from "@aistudy/contracts";
import { cardRecallGrade, cardRecallLabel, cardStudyView } from "./card";
const item = { card: { id: "concept", front: "什么是向量？", back: "有大小和方向的量" } } as ReviewQueueItem;
it("adapts the API card without inventing estimates, outcomes or answer exposure", () => {
  const front = cardStudyView(item, false, null, false, null);
  expect(front.step).toMatchObject({ kind: "card", id: "concept", front: item.card.front, back: "", estimateMinutes: null });
  expect(front.result).toBeNull();
  expect(front.help.canRequest).toBe(false);
  expect(front.photo).toBeUndefined();
  const back = cardStudyView(item, true, "hard", true, "困难");
  expect(back.step).toMatchObject({ back: item.card.back, selectionLocked: true, savedRecall: "困难" });
  expect(back.answer).toEqual({ grade: "hard" });
});
it.each([["again", "重来"], ["hard", "困难"], ["good", "记得"], ["easy", "轻松"]] as const)("preserves the %s grade identity", (grade, label) => {
  expect(cardRecallGrade(grade)).toBe(grade);
  expect(cardRecallLabel(grade)).toBe(label);
});
it("does not map unknown or binary feedback to a review grade", () => {
  expect(cardRecallGrade("correct")).toBeNull();
  expect(cardRecallGrade("incorrect")).toBeNull();
});
