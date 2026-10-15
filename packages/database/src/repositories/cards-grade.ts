import { readCardSourceIds } from "./card-sources";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import {
  reviewGradeSchema,
  type LearningEvent,
  type ReviewGrade,
} from "@aistudy/contracts";
import { createInitialState, scheduleReview } from "@aistudy/domain";
import type { Sql } from "postgres";
import { createOpeningLearningSessionInTx } from "./opening-learning-session-create";
import { insertOpeningLearningObservationInTx } from "./opening-learning-observations";
import {
  createLearningEventRepository,
  LearningEventRepositoryError,
} from "./learning-events";
import {
  assertWorkspaceOwner,
  loadCard,
  loadReviewStateForUpdate,
  lockCardForUpdate,
  writeState,
} from "./cards-ops";
import { assertReplayableReviewEvent } from "./cards-replay";
import { CardRepositoryError, type CardStateRecord } from "./cards-types";

export async function gradeCard(
  sql: Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    cardId: string;
    grade: ReviewGrade;
    idempotencyKey: string;
    occurredAt: string;
    assisted?: boolean;
    now?: Date;
  },
): Promise<{ state: CardStateRecord; event: LearningEvent; created: boolean }> {
  const grade = reviewGradeSchema.parse(input.grade);
  const now = input.now ?? new Date(input.occurredAt);
  return sql.begin(async (tx) => {
    const client = tx as Sql;
    const scope = { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId };
    await lockWorkspaceLearningHistory(tx, scope);
    await lockCardForUpdate(client, input.workspaceId, input.ownerUserId, input.cardId);
    const card = await loadCard(client, input.workspaceId, input.cardId);
    const sourceIds = await readCardSourceIds(tx, input.workspaceId, input.cardId);
    const events = createLearningEventRepository(client);
    const existing = await events.findByIdempotency({
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) {
      assertReplayableReviewEvent(existing, input.cardId);
      const replayed = await loadReviewStateForUpdate(
        client,
        input.workspaceId,
        input.ownerUserId,
        input.cardId,
      );
      if (!replayed) {
        throw new CardRepositoryError("NOT_FOUND", `Review state not found for ${input.cardId}`);
      }
      return { state: replayed, event: existing, created: false };
    }

    await assertWorkspaceOwner(client, input.workspaceId, input.ownerUserId);
    const currentState = await loadReviewStateForUpdate(
      client,
      input.workspaceId,
      input.ownerUserId,
      input.cardId,
    );
    const current = currentState ?? createInitialState(input.cardId, now);
    const next = scheduleReview(current, grade, now);
    const state = await writeState(client, input.workspaceId, input.ownerUserId, next);
    try {
      const event = await events.append({
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
        type: "review",
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.occurredAt,
        contentId: input.cardId,
        contentVersion: card.contentVersion,
        syllabusPointId: card.syllabusPointId,
        payload: {
          grade,
          assisted: input.assisted ?? false,
          excludeFromAssessment: card.excludeFromAssessment,
        },
      });
      assertReplayableReviewEvent(event, input.cardId);
      if (card.courseId) {
        const skillLabel = card.skillLabel ?? "记忆卡片复习";
        const session = await createOpeningLearningSessionInTx(tx, scope, {
          courseId: card.courseId, skillLabel, sourceIds,
        });
        await insertOpeningLearningObservationInTx(tx, scope, {
          sessionId: session.id, courseId: card.courseId, skillLabel, sourceIds,
          answer: `记忆卡片复习（${grade}）\n题目：${card.front}`, outcome: grade === "again" ? "incorrect" : "correct",
          assistance: "independent", verdictSource: "self_report", clientKey: `card-review:${event.id}`,
        });
      }
      return { state, event, created: true };
    } catch (error) {
      if (error instanceof CardRepositoryError) throw error;
      if (error instanceof LearningEventRepositoryError) {
        throw new CardRepositoryError(
          error.code === "NOT_FOUND"
            ? "NOT_FOUND"
            : error.code === "CONFLICT"
              ? "CONFLICT"
              : error.code === "VALIDATION"
                ? "VALIDATION"
                : "WORKSPACE_MISMATCH",
          error.message,
        );
      }
      throw error;
    }
  });
}
