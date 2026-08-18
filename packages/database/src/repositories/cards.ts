import { createInitialState } from "@aistudy/domain";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import {
  assertWorkspaceOwner,
  listCardQueue,
  listWorkspaceCards,
  loadCard,
  writeState,
} from "./cards-ops";
import { gradeCard } from "./cards-grade";
import { CardRepositoryError, mapCard, mapState, type CardRepository, type Row } from "./cards-types";

export {
  CardRepositoryError,
  type CardErrorCode,
  type CardQueueEntry,
  type CardRecord,
  type CardRepository,
  type CardStateRecord,
} from "./cards-types";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export function createCardRepository(sql: Sql): CardRepository {
  return {
    async createCard(input) {
      await assertWorkspaceOwner(sql, input.workspaceId, input.ownerUserId);
      const cardId = input.cardId ?? randomUUID();
      try {
        return await sql.begin(async (tx) => {
          const client = tx as Sql;
          const rows = await client`
            INSERT INTO cards (
              id, workspace_id, owner_user_id, front, back, source_document_id,
              syllabus_point_id, tags
            ) VALUES (
              ${cardId}, ${input.workspaceId}, ${input.ownerUserId}, ${input.front.trim()},
              ${input.back.trim()}, ${input.sourceDocumentId ?? null},
              ${input.syllabusPointId ?? null}, ${input.tags ?? []}
            )
            RETURNING *
          `;
          const card = mapCard(rows[0] as Row);
          await writeState(
            client,
            input.workspaceId,
            input.ownerUserId,
            createInitialState(card.id, new Date()),
          );
          return card;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          try {
            return await loadCard(sql, input.workspaceId, cardId);
          } catch (loadError) {
            if (loadError instanceof CardRepositoryError && loadError.code === "NOT_FOUND") {
              throw new CardRepositoryError(
                "CONFLICT",
                `Card ${cardId} already exists in another workspace`,
              );
            }
            throw loadError;
          }
        }
        throw error;
      }
    },

    async getCard(input) {
      return loadCard(sql, input.workspaceId, input.cardId);
    },

    async updateControls(input) {
      await loadCard(sql, input.workspaceId, input.cardId);
      const keepPause = input.pausedUntil === undefined;
      const keepMaintain = input.maintainUntil === undefined;
      const rows = await sql`
        UPDATE cards SET
          archived = COALESCE(${input.archived ?? null}, archived),
          paused_until = CASE WHEN ${keepPause} THEN paused_until ELSE ${input.pausedUntil ?? null} END,
          maintain_until = CASE WHEN ${keepMaintain} THEN maintain_until ELSE ${input.maintainUntil ?? null} END,
          exclude_from_assessment = COALESCE(
            ${input.excludeFromAssessment ?? null},
            exclude_from_assessment
          ),
          updated_at = now()
        WHERE id = ${input.cardId} AND workspace_id = ${input.workspaceId}
        RETURNING *
      `;
      return mapCard(rows[0] as Row);
    },

    async getState(input) {
      const rows = await sql`
        SELECT * FROM card_review_states
        WHERE workspace_id = ${input.workspaceId}
          AND owner_user_id = ${input.ownerUserId}
          AND card_id = ${input.cardId}
        LIMIT 1
      `;
      return rows[0] ? mapState(rows[0] as Row) : null;
    },

    async upsertState(input) {
      await assertWorkspaceOwner(sql, input.workspaceId, input.ownerUserId);
      await loadCard(sql, input.workspaceId, input.state.cardId);
      return writeState(sql, input.workspaceId, input.ownerUserId, input.state);
    },

    async grade(input) {
      return gradeCard(sql, input);
    },

    async listQueue(input) {
      return listCardQueue(sql, input);
    },

    async listCards(input) {
      return listWorkspaceCards(sql, input);
    },
  };
}
