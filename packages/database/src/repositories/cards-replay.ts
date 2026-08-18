import type { LearningEvent } from "@aistudy/contracts";
import { CardRepositoryError } from "./cards-types";

/**
 * An idempotency key is scoped to workspace+owner, so a key reused by another
 * event type or another card is a caller mistake, not a safe replay.
 */
export function assertReplayableReviewEvent(event: LearningEvent, cardId: string): void {
  if (event.type !== "review") {
    throw new CardRepositoryError(
      "CONFLICT",
      `Idempotency key ${event.idempotencyKey} already belongs to a ${event.type} event`,
    );
  }
  if (event.contentId !== cardId) {
    throw new CardRepositoryError(
      "CONFLICT",
      `Idempotency key ${event.idempotencyKey} already belongs to card ${event.contentId}`,
    );
  }
}
