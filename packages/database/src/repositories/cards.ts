import { captureOpeningObservationCardOrigin } from "./opening-card-drafts";
import { admitLearningSources, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { parseContextSourceRefs } from "./opening-context-provenance";
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
          const scope = { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId };
          await lockWorkspaceLearningHistory(tx, scope);
          let sourceIds = input.observationId ? (await captureOpeningObservationCardOrigin(tx, scope, input.observationId)).sourceIds : [];
          if (input.sourceDocumentId) {
            const [document] = await tx`SELECT d.id,np.document_id AS provenance_id,np.context_source_refs FROM library_documents d
              LEFT JOIN opening_note_provenance np ON np.document_id=d.id AND np.workspace_id=d.workspace_id
              WHERE d.id=${input.sourceDocumentId} AND d.workspace_id=${input.workspaceId} FOR SHARE OF d`;
            if (!document) throw new CardRepositoryError("NOT_FOUND", "source note not found");
            if (document.provenance_id) {
              const refs = parseContextSourceRefs(document.context_source_refs);
              if (!refs) throw new CardRepositoryError("VALIDATION", "source note provenance unavailable");
              sourceIds = [...new Set([...sourceIds, ...refs.map(ref => ref.sourceId)])].sort();
            }
          }
          if (sourceIds.length > 32) throw new CardRepositoryError("VALIDATION", "card source lineage exceeds 32 materials");
          await admitLearningSources(tx, scope, sourceIds);
          if (input.courseId) {
            const courses = await client`SELECT id FROM courses WHERE id=${input.courseId}
              AND workspace_id=${input.workspaceId} AND archived_at IS NULL FOR SHARE`;
            if (!courses.length) throw new CardRepositoryError("NOT_FOUND", "course not found");
          }
          const rows = await client`
            INSERT INTO cards (
              id, workspace_id, owner_user_id, front, back, source_document_id,
              syllabus_point_id, tags, course_id, skill_label, source_ids
            ) VALUES (
              ${cardId}, ${input.workspaceId}, ${input.ownerUserId}, ${input.front.trim()},
              ${input.back.trim()}, ${input.sourceDocumentId ?? null},
              ${input.syllabusPointId ?? null}, ${input.tags ?? []},
              ${input.courseId ?? null}, ${input.skillLabel?.trim() || null}, ${sourceIds}
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
