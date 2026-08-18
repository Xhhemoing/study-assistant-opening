import {
  createCardRequestSchema,
  gradeReviewRequestSchema,
  listReviewQueueQuerySchema,
  updateCardControlsRequestSchema,
  type CreateCardResponse,
  type GradeReviewResponse,
  type ListReviewQueueResponse,
} from "@aistudy/contracts";
import type { Principal } from "../../lib/authorization";
import type { AuthRuntime } from "../auth/service";

export async function gradeReviewForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: unknown,
): Promise<GradeReviewResponse> {
  const parsed = gradeReviewRequestSchema.parse(body);
  const result = await runtime.cards.grade({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    cardId: parsed.cardId,
    grade: parsed.grade,
    assisted: parsed.assisted,
    idempotencyKey: parsed.idempotencyKey,
    occurredAt: parsed.occurredAt ?? new Date().toISOString(),
  });
  return { state: result.state, event: result.event };
}

export async function listReviewQueueForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  query: unknown,
): Promise<ListReviewQueueResponse> {
  const parsed = listReviewQueueQuerySchema.parse(query);
  const items = await runtime.cards.listQueue({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    mode: parsed.mode,
  });
  return {
    items: items.map((item) => ({
      card: item.card,
      state: item.state,
      goalPriority: item.goalPriority,
    })),
  };
}

export async function createCardForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: unknown,
): Promise<CreateCardResponse> {
  const parsed = createCardRequestSchema.parse(body);
  const card = await runtime.cards.createCard({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    cardId: parsed.cardId,
    front: parsed.front,
    back: parsed.back,
    tags: parsed.tags,
    sourceDocumentId: parsed.sourceDocumentId,
    syllabusPointId: parsed.syllabusPointId,
  });
  return { card };
}

export async function updateCardControlsForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: unknown,
): Promise<CreateCardResponse> {
  const parsed = updateCardControlsRequestSchema.parse(body);
  const card = await runtime.cards.updateControls({
    workspaceId: principal.workspaceId,
    cardId: parsed.cardId,
    archived: parsed.archived,
    pausedUntil: parsed.pausedUntil,
    maintainUntil: parsed.maintainUntil,
    excludeFromAssessment: parsed.excludeFromAssessment,
  });
  return { card };
}
