import { cardReviewKind } from "@aistudy/contracts";
import {
  issueOfflineFlashcardLease, MAX_OFFLINE_LEASE_CARDS,
  type ForbiddenMissVariantField, type IssueOfflineFlashcardLeaseInput, type IssueOfflineFlashcardLeaseResult,
  type OfflineLeaseCardCandidate, type OfflineMissVariantCandidate, type ServerFlashcardSnapshot,
} from "../offline-companion-bridge";
import type { ReviewQueueItem, TriagedReviewQueueItem } from "./eligibility";

export { reconcileOfflineLeaseOutbox as reconcileReviewQueueOfflineOutbox } from "../offline-companion-bridge";

type FreshOfflineVariant = Pick<OfflineMissVariantCandidate, "freshVariantId" | "freshVariantStem" | ForbiddenMissVariantField>;

export type IssueReviewQueueOfflineLeaseInput = Omit<IssueOfflineFlashcardLeaseInput, "candidates"> & {
  /** Server-selected queue in triage order, after eligibility checks. */
  readonly queue: readonly (ReviewQueueItem | TriagedReviewQueueItem)[];
  readonly serverCards: ReadonlyMap<string, ServerFlashcardSnapshot>;
  /** Server-generated stem and private values used for leak screening, keyed by card ID. */
  readonly freshVariants?: ReadonlyMap<string, FreshOfflineVariant>;
};

export function issueReviewQueueOfflineLease({
  queue, serverCards, freshVariants, ...lease
}: IssueReviewQueueOfflineLeaseInput): IssueOfflineFlashcardLeaseResult {
  const candidates: OfflineLeaseCardCandidate[] = [];
  for (const entry of queue) {
    // The core's 30-card lease cap is stricter than the 200-card SRS session cap.
    if (candidates.length === MAX_OFFLINE_LEASE_CARDS) break;
    const { card } = "item" in entry ? entry.item : entry;
    const snapshot = serverCards.get(card.id);
    if (card.ownerUserId !== lease.learnerId || snapshot?.cardId !== card.id) continue;

    const binding = { cardId: card.id, cardRevision: snapshot.revision, lastServerReviewedAtMs: snapshot.lastServerReviewedAtMs };
    if (cardReviewKind(card) === "question") {
      const variant = freshVariants?.get(card.id);
      if (!variant) continue;
      // Preserve hidden fields and accessors for the core's plain-data check.
      const fields = Object.getOwnPropertyDescriptors(variant);
      const referenceAnswer = fields.referenceAnswer;
      candidates.push(Object.create(Object.getPrototypeOf(variant), {
        ...fields,
        ...Object.getOwnPropertyDescriptors({ ...binding, cardKind: "miss_variant" }),
        referenceAnswer: !referenceAnswer || (Object.hasOwn(referenceAnswer, "value") && referenceAnswer.value == null)
          ? { value: card.back }
          : referenceAnswer,
      }) as OfflineMissVariantCandidate);
    } else {
      candidates.push({ ...binding, cardKind: "flashcard", prompt: card.front, backSummary: card.back });
    }
  }
  return issueOfflineFlashcardLease({ ...lease, candidates });
}
