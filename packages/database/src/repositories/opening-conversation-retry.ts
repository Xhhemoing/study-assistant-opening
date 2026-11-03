import type { Sql, TransactionSql } from "postgres";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { studyContextAnchorSchema, tutorModeSchema, composerPurposeSchema, uuidSchema } from "@aistudy/contracts";

export function savedTurnRetryAssistantId(clientKey: string): string | null {
  if (!clientKey.startsWith("retry-")) return null;
  const parsed = uuidSchema.safeParse(clientKey.slice(6));
  return parsed.success ? parsed.data : null;
}

const savedRetrySchema = z.object({
  text: z.string(), mode: tutorModeSchema,
  sourceIds: z.array(uuidSchema), sourceVersions: z.record(uuidSchema, z.number().int().nonnegative()),
  currentPage: z.number().int().positive().nullable(), chunkId: uuidSchema.nullable(),
  learningSessionId: uuidSchema.nullable(), attemptId: uuidSchema.nullable(),
  strategyTemplateId: z.string().nullable(), contextAnchor: studyContextAnchorSchema.nullable(),
  purpose: composerPurposeSchema.nullable(),
});
export type SavedTurnRetryIntent = z.infer<typeof savedRetrySchema>;

export function savedTurnRetryMatches(input: {
  text: string; mode: string; sourceIds: string[]; currentPage: number | null;
  chunkId: string | null; learningSessionId: string | null; attemptId?: string | null;
  strategyTemplateId?: string | null; contextAnchor?: SavedTurnRetryIntent["contextAnchor"];
  purpose?: SavedTurnRetryIntent["purpose"]; querySystem?: boolean;
}, original: SavedTurnRetryIntent): boolean {
  if (input.querySystem) return false;
  return isDeepStrictEqual({
    text: input.text, mode: input.mode, sourceIds: [...new Set(input.sourceIds)].sort(),
    currentPage: input.currentPage, chunkId: input.chunkId, learningSessionId: input.learningSessionId,
    attemptId: input.attemptId ?? null, strategyTemplateId: input.strategyTemplateId ?? null,
    contextAnchor: input.contextAnchor ?? null, purpose: input.purpose ?? null,
  }, {
    text: original.text, mode: original.mode, sourceIds: [...original.sourceIds].sort(),
    currentPage: original.currentPage, chunkId: original.chunkId, learningSessionId: original.learningSessionId,
    attemptId: original.attemptId, strategyTemplateId: original.strategyTemplateId,
    contextAnchor: original.contextAnchor, purpose: original.purpose,
  });
}

/** Read only the owned, durable failed pair; the browser cannot supply its snapshot. */
export async function readOpeningSavedTurnRetry(
  db: Sql | TransactionSql,
  scope: { workspaceId: string; ownerUserId: string },
  conversationId: string,
  assistantTurnId: string,
): Promise<SavedTurnRetryIntent | null> {
  const rows = await db`
    SELECT u.text, u.mode, u.source_ids AS "sourceIds", u.source_versions AS "sourceVersions",
      u.current_page AS "currentPage", u.chunk_id AS "chunkId", u.learning_session_id AS "learningSessionId",
      u.attempt_id AS "attemptId", u.strategy_template_id AS "strategyTemplateId",
      u.context_anchor AS "contextAnchor", u.composer_purpose AS purpose
    FROM opening_tutor_jobs j
    JOIN opening_turns a ON a.id=j.assistant_turn_id AND a.workspace_id=j.workspace_id AND a.conversation_id=j.conversation_id
    JOIN opening_turns u ON u.id=j.user_turn_id AND u.workspace_id=j.workspace_id AND u.conversation_id=j.conversation_id
    JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
    JOIN workspaces w ON w.id=c.workspace_id AND w.owner_user_id=c.owner_user_id
    WHERE j.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
      AND j.conversation_id=${conversationId} AND a.id=${assistantTurnId}
      AND a.role='assistant' AND a.status='failed' AND u.role='user'
      AND j.status IN ('failed','cancelled') AND NOT u.query_system AND NOT a.query_system
      AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id=j.workspace_id AND (e.source_id=ANY(u.source_ids) OR u.source_versions ? e.source_id::text))
    LIMIT 1`;
  return rows[0] ? savedRetrySchema.parse(rows[0]) : null;
}
