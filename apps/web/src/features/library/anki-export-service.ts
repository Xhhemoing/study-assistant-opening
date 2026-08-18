import {
  ankiExportRequestSchema,
  type AnkiExportResponse,
} from "@aistudy/contracts";
import { exportAnkiDeck, type AnkiSourceCard } from "@aistudy/domain";
import { PromotionRepositoryError } from "@aistudy/database";
import type { Principal } from "../../lib/authorization";
import type { AuthRuntime } from "../auth/service";

export async function exportAnkiForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: unknown,
): Promise<AnkiExportResponse> {
  const parsed = ankiExportRequestSchema.parse(body ?? {});
  const cards = parsed.cardId
    ? [await runtime.cards.getCard({ workspaceId: principal.workspaceId, cardId: parsed.cardId })]
    : await runtime.cards.listCards({
      workspaceId: principal.workspaceId,
      ownerUserId: principal.userId,
    });

  const sources = await Promise.all(cards.map((card) => toSourceCard(runtime, principal, card)));
  return { format: "anki", ...exportAnkiDeck({ cards: sources }) };
}

async function toSourceCard(
  runtime: AuthRuntime,
  principal: Principal,
  card: {
    id: string;
    front: string;
    back: string;
    tags: string[];
    sourceDocumentId: string | null;
    syllabusPointId: string | null;
  },
): Promise<AnkiSourceCard> {
  const state = await runtime.cards.getState({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    cardId: card.id,
  });
  let relationCount = 0;
  let explorationProvenance = false;
  if (card.sourceDocumentId) {
    const relations = await runtime.library.listRelations({
      workspaceId: principal.workspaceId,
      subjectType: "document",
      subjectId: card.sourceDocumentId,
    });
    relationCount = relations.length;
    try {
      const promotion = await runtime.promotions.getByDocumentTarget({
        workspaceId: principal.workspaceId,
        documentId: card.sourceDocumentId,
      });
      explorationProvenance = Boolean(promotion);
    } catch (error) {
      if (!(error instanceof PromotionRepositoryError && error.code === "NOT_FOUND")) throw error;
    }
  }
  return {
    id: card.id,
    front: card.front,
    back: card.back,
    tags: card.tags,
    sourceDocumentId: card.sourceDocumentId,
    scheduling: state
      ? {
        dueAt: state.dueAt,
        intervalDays: state.intervalDays,
        ease: state.ease,
        reps: state.reps,
        lapses: state.lapses,
      }
      : null,
    unsupported: {
      courseRequirements: Boolean(card.syllabusPointId),
      explorationProvenance,
      relations: relationCount > 0,
      reviewHistory: Boolean(state && (state.reps > 0 || state.lastGrade)),
    },
  };
}
