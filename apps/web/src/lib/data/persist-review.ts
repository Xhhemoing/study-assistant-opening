import {
  createCardResponseSchema,
  gradeReviewResponseSchema,
  listReviewQueueResponseSchema,
  type ReviewCard,
  type ReviewGrade,
  type ReviewState,
} from "@aistudy/contracts";
import type { StudyDataProvider } from "./types";

async function persistCard(card: ReviewCard): Promise<void> {
  const response = await fetch("/api/cards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cardId: card.id,
      front: card.front,
      back: card.back,
      sourceDocumentId: card.sourceDocumentId,
      syllabusPointId: card.syllabusPointId,
      tags: card.tags,
    }),
  });
  if (!response.ok) throw new Error("复习卡保存失败");
  createCardResponseSchema.parse(await response.json());
}

async function persistGrade(
  cardId: string,
  grade: ReviewGrade,
  idempotencyKey: string,
): Promise<ReviewState> {
  const response = await fetch("/api/reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cardId, grade, idempotencyKey }),
  });
  if (!response.ok) throw new Error("评分提交失败");
  return gradeReviewResponseSchema.parse(await response.json()).state;
}

export function withPersistedReviews(provider: StudyDataProvider): StudyDataProvider {
  return {
    ...provider,
    async listDueCards(at, options) {
      const local = await provider.listDueCards(at);
      for (const item of local) await persistCard(item.card);
      const mode = options?.mode ?? "auto";
      const response = await fetch(`/api/reviews?mode=${encodeURIComponent(mode)}`);
      if (!response.ok) throw new Error("复习队列加载失败");
      return listReviewQueueResponseSchema.parse(await response.json()).items;
    },
    async gradeCard(cardId, grade, input) {
      const due = await provider.listDueCards();
      const card = due.find((item) => item.card.id === cardId)?.card;
      if (!card) throw new Error("复习卡不存在");
      await persistCard(card);
      return persistGrade(
        cardId,
        grade,
        input?.idempotencyKey ?? `review-${cardId}-${Date.now()}`,
      );
    },
  };
}
