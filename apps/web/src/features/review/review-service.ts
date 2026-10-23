import {
  createCardRequestSchema,
  cardReviewKind,
  gradeReviewRequestSchema,
  listReviewQueueQuerySchema,
  updateCardControlsRequestSchema,
  type CreateCardResponse,
  type GradeReviewResponse,
  type ListReviewQueueResponse,
} from "@aistudy/contracts";
import { createOpeningPlanningSettingsRepository } from "@aistudy/database";
import { CardRepositoryError } from "@aistudy/database";
import { resolveWorkspaceTimeZone } from "@aistudy/domain";
import type { Principal } from "../../lib/authorization";
import type { AuthRuntime } from "../auth/service";

export async function gradeReviewForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: unknown,
): Promise<GradeReviewResponse> {
  const parsed = gradeReviewRequestSchema.parse(body);
  const card = await runtime.cards.getCard({ workspaceId: principal.workspaceId, cardId: parsed.cardId });
  if (cardReviewKind(card) === "question") throw new CardRepositoryError("CONFLICT", "这是一张题目卡，请完成新变式后复习。");
  const result = await runtime.cards.grade({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    cardId: parsed.cardId,
    grade: parsed.grade,
    assisted: parsed.assisted,
    idempotencyKey: parsed.idempotencyKey,
    occurredAt: parsed.occurredAt ?? new Date().toISOString(),
  });
  return { state: result.state, event: result.event, evidence: result.evidence };
}

export type ListReviewQueueDeps = {
  /** Request clock; read exactly once per request. */
  now?: () => Date;
  /** Workspace business IANA zone (planning_settings.timeZone; default Asia/Shanghai). */
  resolveTimeZone?: (scope: { workspaceId: string; ownerUserId: string }) => Promise<string>;
};

/** planning_settings.timeZone for the workspace; missing/invalid stored settings → default zone. */
export async function resolveWorkspaceTimeZoneForScope(
  runtime: AuthRuntime,
  scope: { workspaceId: string; ownerUserId: string },
): Promise<string> {
  const preference = await createOpeningPlanningSettingsRepository(runtime.sql).get(scope);
  return resolveWorkspaceTimeZone(preference.settings?.timeZone);
}

export async function listReviewQueueForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  query: unknown,
  deps: ListReviewQueueDeps = {},
): Promise<ListReviewQueueResponse> {
  const parsed = listReviewQueueQuerySchema.parse(query);
  const scope = { workspaceId: principal.workspaceId, ownerUserId: principal.userId };
  const now = deps.now?.() ?? new Date();
  const timeZone = await (deps.resolveTimeZone ?? ((s) => resolveWorkspaceTimeZoneForScope(runtime, s)))(scope);
  const items = await runtime.cards.listQueue({
    ...scope,
    mode: parsed.mode,
    now,
    timeZone,
  });
  return {
    items: items.map((item) => ({
      card: cardReviewKind(item.card) === "question" ? { ...item.card, front: `${item.card.skillLabel ?? "题目"} · 变式复习`, back: "完成变式后查看解答" } : item.card,
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
    reviewKind: parsed.reviewKind,
    sourceDocumentId: parsed.sourceDocumentId,
    syllabusPointId: parsed.syllabusPointId,
    courseId: parsed.courseId,
    observationId: parsed.observationId,
    skillLabel: parsed.skillLabel,
  });
  return { card };
}

export async function countDueReviewsForPrincipal(runtime: AuthRuntime, principal: Principal, deps: ListReviewQueueDeps = {}): Promise<{ count: number }> {
  // Reuse the same scoped queue and workspace-day rules without calling the
  // content-delivery boundary. No card content or exposure receipt is returned.
  const queue = await listReviewQueueForPrincipal(runtime, principal, { mode: "auto" }, deps);
  return { count: queue.items.length };
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
