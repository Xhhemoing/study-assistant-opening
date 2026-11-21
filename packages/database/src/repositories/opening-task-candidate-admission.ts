import type { TransactionSql } from "postgres";
import { assistantCandidateSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";
import { includedTurn } from "./opening-backup-record-predicates";
import { readTurnsWithActiveMemoryDependencies, turnHasMemoryDependencies, turnPinnedSourceRefs } from "./opening-context-provenance";

/** Share locks admit parallel accepts but serialize against owner/privacy deletion. */
export async function admitTaskCandidate(tx: TransactionSql, scope: OpeningScope, id: string): Promise<void> {
  const owners = await tx`
    SELECT id FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
    FOR SHARE`;
  if (!owners.length) throw new OpeningPlanError("CONFLICT", "task candidate unavailable");
  const [candidate] = await tx<{ payload: unknown; source_turn_id: string; has_memory_dependencies: boolean | null }[]>`
    SELECT c.payload, t.id AS source_turn_id, ${turnHasMemoryDependencies(tx)} AS has_memory_dependencies
    FROM opening_assistant_candidates c
    JOIN opening_conversations conv ON conv.id = c.conversation_id AND conv.workspace_id = c.workspace_id
      AND conv.owner_user_id = ${scope.ownerUserId}
    JOIN opening_turns t ON t.id = c.source_turn_id AND t.conversation_id = c.conversation_id
      AND t.workspace_id = c.workspace_id AND t.status = 'complete'
    WHERE c.id = ${id} AND c.workspace_id = ${scope.workspaceId}
    FOR SHARE OF conv, t`;
  const payload = assistantCandidateSchema.safeParse(candidate?.payload);
  if (!candidate || !payload.success || payload.data.kind !== "task") {
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
        UNION SELECT pin.source_id FROM (${turnPinnedSourceRefs(tx, tx`t.source_versions`, tx`t.context_anchor`)}) pin
        UNION SELECT citation->>'sourceId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.citations) = 'array' THEN t.citations ELSE '[]'::jsonb END) citation
        UNION SELECT context_ref->>'sourceId'
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.context_source_refs) = 'array' THEN t.context_source_refs ELSE '[]'::jsonb END) context_ref
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
  if (candidate.has_memory_dependencies) {
    const active = await readTurnsWithActiveMemoryDependencies(tx, scope.workspaceId, [candidate.source_turn_id]);
    if (!active.has(candidate.source_turn_id)) {
      throw new OpeningPlanError("VALIDATION", "task candidate memory dependency is no longer active");
    }
  }
}
