import type { TransactionSql } from "postgres";
import { assistantCandidateSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";
import {
  assistantDirectSourcesVersioned, contextSourceRefsIncluded, lineageUuid, pairedUserTurnId, parseContextMemoryDependencyIds,
  readTurnsWithActiveMemoryDependencies, turnContextSourceRefs, turnDirectSourcesVersioned, turnHasMemoryDependencies,
  turnLineageCourse, turnMaterialUse, turnPinnedSourceRefs, type FragmentFactory,
} from "./opening-context-provenance";
import { lockActiveMemoryCourse, lockMemoryMaterialSources, sourceMaterialsActive, turnMaterialRows } from "./opening-memory-admission";

function candidateListedMaterials(tx: TransactionSql): ReturnType<FragmentFactory> {
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
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.source_ids) = 'array' THEN c.source_ids ELSE '[]'::jsonb END) ref(id)`;
}

function candidateMaterialRows(tx: TransactionSql, scope: OpeningScope): ReturnType<FragmentFactory> {
  return tx`
    ${candidateListedMaterials(tx)}
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

function assistantCandidateSourcesVersioned(tx: TransactionSql, workspaceId: string) {
  const array = (items: FragmentFactory) => tx`CASE WHEN jsonb_typeof(${items()}) = 'array' THEN ${items()} ELSE '[]'::jsonb END`;
  return tx`(t.role <> 'assistant' OR (
    ${assistantDirectSourcesVersioned(tx, "t")}
    AND EXISTS (
      SELECT 1 FROM LATERAL (
        SELECT array_remove(ARRAY(SELECT ${lineageUuid(tx, () => tx`material.source_id`)}
          FROM (${candidateListedMaterials(tx)}) material WHERE NOT material.memory_only), NULL::uuid) AS ids
      ) direct
      CROSS JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(refs.ref), '[]'::jsonb) AS refs
        FROM (
          SELECT ref FROM jsonb_array_elements(${array(() => turnContextSourceRefs(tx, "t"))}) ref
          UNION ALL
          SELECT citation - 'memoryOnly' FROM jsonb_array_elements(${array(() => tx`t.citations`)}) citation
          UNION ALL
          SELECT user_ref.ref FROM opening_turns u
          CROSS JOIN LATERAL (
            SELECT ref FROM jsonb_array_elements(${array(() => tx`u.context_source_refs`)}) ref
            UNION ALL
            SELECT citation - 'memoryOnly' FROM jsonb_array_elements(${array(() => tx`u.citations`)}) citation
            UNION ALL
            SELECT jsonb_build_object('sourceId', pin.source_id, 'sourceVersion', pin.source_version)
            FROM (${turnPinnedSourceRefs(tx, () => tx`u.source_versions`, () => tx`u.context_anchor`)}) pin
            WHERE pin.version_required OR pin.source_version IS NOT NULL
          ) user_ref(ref)
          WHERE u.id = (${pairedUserTurnId(tx, () => tx`t`)}) AND u.workspace_id=t.workspace_id
            AND u.conversation_id=t.conversation_id AND u.role='user' AND u.status='complete'
        ) refs(ref)
        WHERE ${lineageUuid(tx, () => tx`refs.ref->>'sourceId'`)} = ANY(direct.ids)
      ) evidence
      WHERE ${turnDirectSourcesVersioned(tx, () => tx`direct.ids`, () => tx`evidence.refs`, () => tx`'[]'::jsonb`)}
        AND ${contextSourceRefsIncluded(tx, workspaceId, () => tx`evidence.refs`)}
    )
  ))`;
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
      ${turnLineageCourse(tx, "t", () => tx`conv.course_id`, () => tx`conv.owner_user_id`)} AS course_id,
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
      AND ${assistantCandidateSourcesVersioned(tx, scope.workspaceId)}
      AND ${sourceMaterialsActive(tx, scope.workspaceId, () => candidateMaterialRows(tx, scope), {
        lockedSourceIds,
        memoryCourse: () => tx`${candidate.course_id ?? null}::uuid`,
        materialUse: candidate.material_use,
        directMaterialPolicy: true,
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
