import type { TransactionSql } from "postgres";
import { assistantCandidateSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";
import { includedTurn } from "./opening-backup-record-predicates";

/** Share locks admit parallel accepts but serialize against owner/privacy deletion. */
export async function admitTaskCandidate(tx: TransactionSql, scope: OpeningScope, id: string): Promise<void> {
  const owners = await tx`
    SELECT id FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
    FOR SHARE`;
  if (!owners.length) throw new OpeningPlanError("CONFLICT", "task candidate unavailable");
  const candidates = await tx`
    SELECT c.payload FROM opening_assistant_candidates c
    JOIN opening_conversations conv ON conv.id = c.conversation_id AND conv.workspace_id = c.workspace_id
      AND conv.owner_user_id = ${scope.ownerUserId}
    JOIN opening_turns t ON t.id = c.source_turn_id AND t.conversation_id = c.conversation_id
      AND t.workspace_id = c.workspace_id AND t.status = 'complete'
    WHERE c.id = ${id} AND c.workspace_id = ${scope.workspaceId}
    FOR SHARE OF conv, t`;
  const payload = assistantCandidateSchema.safeParse(candidates[0]?.payload);
  if (!payload.success || payload.data.kind !== "task") {
    throw new OpeningPlanError("CONFLICT", "task candidate unavailable");
  }
  // Lock referenced source rows before checking their current versions/admission.
  await tx`
    SELECT s.id FROM opening_sources s
    WHERE s.workspace_id = ${scope.workspaceId} AND s.id::text IN (
      SELECT lower(ref.id) FROM opening_assistant_candidates c
      JOIN opening_turns t ON t.id = c.source_turn_id
      CROSS JOIN LATERAL (
        SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.source_ids) = 'array' THEN c.source_ids ELSE '[]'::jsonb END) AS id
        UNION SELECT unnest(t.source_ids)::text
        UNION SELECT jsonb_object_keys(CASE WHEN jsonb_typeof(t.source_versions) = 'object' THEN t.source_versions ELSE '{}'::jsonb END)
        UNION SELECT citation->>'sourceId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.citations) = 'array' THEN t.citations ELSE '[]'::jsonb END) citation
        UNION SELECT k.source_id::text FROM opening_source_chunks k WHERE k.id = t.chunk_id
      ) ref WHERE c.id = ${id}
    ) ORDER BY s.id FOR SHARE`;
  // Share the existing restore/context lineage rules: revoked, missing, excluded,
  // malformed, or version-drifted evidence is never admitted for a replay either.
  const admitted = await tx`
    SELECT c.id FROM opening_assistant_candidates c
    JOIN opening_conversations conv ON conv.id = c.conversation_id
    JOIN opening_turns t ON t.id = c.source_turn_id
    WHERE c.id = ${id} AND c.workspace_id = ${scope.workspaceId}
      AND (conv.course_id IS NULL OR EXISTS (
        SELECT 1 FROM courses course WHERE course.id = conv.course_id AND course.workspace_id = ${scope.workspaceId}
      ))
      AND jsonb_typeof(c.source_ids) = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.source_ids) = 'array' THEN c.source_ids ELSE '[]'::jsonb END) ref(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM opening_sources s WHERE s.id::text = lower(ref.id)
            AND s.workspace_id = ${scope.workspaceId} AND s.upload_state = 'uploaded'
        ) OR EXISTS (
          SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id = ${scope.workspaceId} AND e.source_id::text = lower(ref.id)
        )
      ) AND ${includedTurn(tx, scope.workspaceId, scope.ownerUserId, "t")}`;
  if (!admitted.length) throw new OpeningPlanError("VALIDATION", "task candidate source is unavailable or excluded");
}
