import type { TransactionSql } from "postgres";
import { assistantCandidateSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";
import { lineageUuid, parseContextMemoryDependencyIds, readTurnsWithActiveMemoryDependencies, turnHasMemoryDependencies, turnLineageCourse, turnMaterialUse, type FragmentFactory } from "./opening-context-provenance";
import { lockActiveMemoryCourse, lockMemoryMaterialSources, sourceMaterialsActive, turnMaterialRows } from "./opening-memory-admission";

function candidateMaterialRows(tx: TransactionSql, scope: OpeningScope): ReturnType<FragmentFactory> {
  // Candidate source_ids also includes inherited references. Every direct use
  // of the same source still gets its own row and must satisfy the saved policy.
  return tx`
    SELECT ref.id AS source_id, NULL::text AS version, false AS version_required,
      COALESCE((
        SELECT bool_and(COALESCE(saved_ref->'memoryOnly' = 'true'::jsonb, false))
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.context_source_refs) = 'array'
          THEN t.context_source_refs ELSE '[]'::jsonb END) saved_ref
        WHERE lower(saved_ref->>'sourceId') = lower(ref.id)
      ), false) AS memory_only
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.source_ids) = 'array' THEN c.source_ids ELSE '[]'::jsonb END) ref(id)
    UNION ALL
    ${turnMaterialRows(tx, true)}
    UNION ALL
    SELECT ref.id::text, NULL::text, false, false
    FROM (SELECT t.learning_session_id AS id WHERE t.learning_session_id IS NOT NULL) saved
    LEFT JOIN opening_learning_sessions session ON session.id = saved.id AND session.workspace_id = ${scope.workspaceId}
      AND session.owner_user_id = ${scope.ownerUserId}
    LEFT JOIN opening_teaching_activities activity ON activity.id = session.activity_id
      AND activity.workspace_id = session.workspace_id AND activity.owner_user_id = session.owner_user_id
    CROSS JOIN LATERAL unnest(CASE WHEN activity.id IS NULL THEN ARRAY[NULL]::uuid[]
      ELSE session.source_ids || activity.source_ids END) ref(id)`;
}

/** Share locks admit parallel accepts but serialize against owner/privacy deletion. */
export async function admitTaskCandidate(tx: TransactionSql, scope: OpeningScope, id: string): Promise<string | null> {
  const owners = await tx`
    SELECT id FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
    FOR SHARE`;
  if (!owners.length) throw new OpeningPlanError("CONFLICT", "task candidate unavailable");
  const [candidate] = await tx<{ payload: unknown; source_turn_id: string; has_memory_dependencies: boolean | null;
    course_id: string | null; material_use: "citation" | "practice"; source_ids: string[]; role: string; context_source_refs: unknown }[]>`
    SELECT c.payload, t.id AS source_turn_id, ${turnHasMemoryDependencies(tx)} AS has_memory_dependencies,
      ${turnLineageCourse(tx, "t", () => tx`conv.course_id`)} AS course_id,
      ${turnMaterialUse(tx, "t")} AS material_use, t.role, t.context_source_refs,
      array_remove(ARRAY(SELECT DISTINCT ${lineageUuid(tx, () => tx`ref.source_id`)}
        FROM (${candidateMaterialRows(tx, scope)}) ref), NULL::uuid) AS source_ids
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
  if (candidate.course_id && !(await lockActiveMemoryCourse(tx, scope, candidate.course_id))) {
    throw new OpeningPlanError("VALIDATION", "task candidate source is unavailable or excluded");
  }
  const dependencyTurnId = candidate.has_memory_dependencies ? candidate.source_turn_id : null;
  const sourceIds = new Set(candidate.source_ids?.filter(Boolean));
  let lockedSourceIds: string[] = [];
  const acquire = async () => {
    lockedSourceIds = await lockMemoryMaterialSources(tx, scope, sourceIds);
    return lockedSourceIds;
  };
  const active = dependencyTurnId === null ? null :
    await readTurnsWithActiveMemoryDependencies(tx, scope.workspaceId, [dependencyTurnId], { sourceIds, acquire });
  if (dependencyTurnId === null) await acquire();

  const admitted = await tx`
    SELECT c.id FROM opening_assistant_candidates c
    JOIN opening_turns t ON t.id = c.source_turn_id AND t.id = ${candidate.source_turn_id}
    WHERE c.id = ${id} AND c.workspace_id = ${scope.workspaceId}
      AND jsonb_typeof(c.source_ids) = 'array'
      AND jsonb_typeof(t.source_versions) = 'object' AND jsonb_typeof(t.citations) = 'array'
      AND ${sourceMaterialsActive(tx, scope.workspaceId, () => candidateMaterialRows(tx, scope), {
        lockedSourceIds,
        memoryCourse: () => tx`${candidate.course_id ?? null}::uuid`,
        materialUse: candidate.material_use,
        authorizeMemoryOnlySeparately: true,
      })}`;
  const refs = candidate.context_source_refs ?? (candidate.role === "assistant" ? null : []);
  const validRefs = parseContextMemoryDependencyIds(refs) !== null;
  if (!admitted.length || !validRefs) throw new OpeningPlanError("VALIDATION", "task candidate source is unavailable or excluded");
  if (dependencyTurnId !== null && !active?.has(dependencyTurnId)) {
    throw new OpeningPlanError("VALIDATION", "task candidate memory dependency is no longer active");
  }
  return dependencyTurnId;
}

/** Read-only so callers can repeat admission after locking the candidate. */
export async function assertTaskCandidateMemoryDependencies(
  tx: TransactionSql, workspaceId: string, dependencyTurnId: string | null,
): Promise<void> {
  if (dependencyTurnId === null) return;
  const active = await readTurnsWithActiveMemoryDependencies(tx, workspaceId, [dependencyTurnId]);
  if (!active.has(dependencyTurnId)) {
    throw new OpeningPlanError("VALIDATION", "task candidate memory dependency is no longer active");
  }
}
