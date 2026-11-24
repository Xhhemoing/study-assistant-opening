import type { TransactionSql } from "postgres";
import { assistantCandidateSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";
import {
  assistantDirectSourcesVersioned, contextSourceRefsIncluded, historicalUserTurnId, lineageUuid, pairedUserTurnId, parseContextMemoryDependencyIds,
  readTurnMemoryDependencyDeadlines, turnContextSourceRefs, turnDirectSourcesVersioned, turnHasMemoryDependencies,
  turnHasOwnedSession, turnLineageCourse, turnMaterialRows, turnMaterialUse, turnPinnedSourceRefs, type FragmentFactory,
} from "./opening-context-provenance";
import { lockActiveMemoryCourses, lockMemoryMaterialSources, sourceMaterialsActive } from "./opening-memory-admission";
import { readTutorHistoryAncestors, readTutorHistoryAncestorStatus } from "./opening-tutor-history";
import { turnUsesInactiveMisconception } from "./v3-bitemporal-misconception-memory";

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
    ${turnMaterialRows(tx, () => tx`${scope.ownerUserId}::uuid`)}`;
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

function taskTurnOriginActive(tx: TransactionSql, workspaceId: string, alias: "a" | "u",
  conversationCourse: FragmentFactory, owner: FragmentFactory, lockedSourceIds?: string[],
) {
  const turn: FragmentFactory = () => alias === "a" ? tx`a` : tx`u`;
  const userRefs: FragmentFactory = () => tx`COALESCE(u.context_source_refs, '[]'::jsonb)`;
  return tx`${turnHasOwnedSession(tx, turn, owner)}
    AND jsonb_typeof(${turn()}.source_versions)='object' AND jsonb_typeof(${turn()}.citations)='array'
    ${alias === "u" ? tx`AND ${contextSourceRefsIncluded(tx, workspaceId, userRefs)}` : tx``}
    AND ${sourceMaterialsActive(tx, workspaceId, () => turnMaterialRows(tx, owner, turn), {
      lockedSourceIds, memoryCourse: () => turnLineageCourse(tx, alias, conversationCourse, owner),
      originUse: () => turnMaterialUse(tx, alias), directMaterialPolicy: true, authorizeMemoryOnlySeparately: true,
    })}`;
}

function pairedUserUsesInactiveMisconception(tx: TransactionSql) {
  return tx`EXISTS (SELECT 1 FROM LATERAL (SELECT u.*) t WHERE ${turnUsesInactiveMisconception(tx)})`;
}

/** Share locks admit parallel accepts but serialize against owner/privacy deletion. */
export async function admitTaskCandidate(tx: TransactionSql, scope: OpeningScope, id: string): Promise<string | null> {
  const owners = await tx`
    SELECT id FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
    FOR SHARE`;
  if (!owners.length) throw new OpeningPlanError("CONFLICT", "task candidate unavailable");
  const [candidate] = await tx<{ payload: unknown; source_turn_id: string; has_memory_dependencies: boolean | null;
    course_id: string | null; material_use: "citation" | "practice"; source_ids: string[]; role: string; context_source_refs: unknown;
    historical_user_turn_id: string | null; paired_user_turn_id: string | null;
    user_course_id: string | null; user_source_ids: string[] | null }[]>`
    SELECT c.payload, t.id AS source_turn_id,
      (${turnHasMemoryDependencies(tx)} OR ${turnHasMemoryDependencies(tx, () => tx`u.context_source_refs`)}) AS has_memory_dependencies,
      ${turnLineageCourse(tx, "t", () => tx`conv.course_id`, () => tx`conv.owner_user_id`)} AS course_id,
      ${turnMaterialUse(tx, "t")} AS material_use, t.role, t.context_source_refs,
      ${historicalUserTurnId(tx)} AS historical_user_turn_id,
      array_remove(ARRAY(SELECT DISTINCT ${lineageUuid(tx, () => tx`ref.source_id`)}
        FROM (${candidateMaterialRows(tx, scope)}) ref), NULL::uuid) AS source_ids,
      u.id AS paired_user_turn_id,
      CASE WHEN u.id IS NOT NULL THEN ${turnLineageCourse(tx, "u", () => tx`conv.course_id`, () => tx`conv.owner_user_id`)} END AS user_course_id,
      CASE WHEN u.id IS NOT NULL THEN array_remove(ARRAY(SELECT DISTINCT ${lineageUuid(tx, () => tx`ref.source_id`)}
        FROM (${turnMaterialRows(tx, () => tx`conv.owner_user_id`, () => tx`u`)}) ref), NULL::uuid) END AS user_source_ids
    FROM opening_assistant_candidates c
    JOIN opening_conversations conv ON conv.id = c.conversation_id AND conv.workspace_id = c.workspace_id
      AND conv.owner_user_id = ${scope.ownerUserId}
    JOIN opening_turns t ON t.id = c.source_turn_id AND t.conversation_id = c.conversation_id
      AND t.workspace_id = c.workspace_id AND t.status = 'complete'
    LEFT JOIN opening_turns u ON t.role='assistant' AND u.id=(${pairedUserTurnId(tx, () => tx`t`)})
      AND u.workspace_id=t.workspace_id AND u.conversation_id=t.conversation_id AND u.role='user' AND u.status='complete'
    WHERE c.id = ${id} AND c.workspace_id = ${scope.workspaceId}`;
  const payload = assistantCandidateSchema.safeParse(candidate?.payload);
  if (!candidate || !payload.success || payload.data.kind !== "task") {
    throw new OpeningPlanError("CONFLICT", "task candidate unavailable");
  }
  const historicalUserTurn = candidate.historical_user_turn_id;
  const sourceIds = new Set([...(candidate.source_ids ?? []), ...(candidate.user_source_ids ?? [])].filter(Boolean));
  const courseIds = new Set([candidate.course_id, candidate.user_course_id].filter((course): course is string => !!course));
  const invalidSource = () => new OpeningPlanError("VALIDATION", "task candidate source is unavailable or excluded");
  if (historicalUserTurn && !await readTutorHistoryAncestors(tx, scope, historicalUserTurn,
    { collectSourceIds: sourceIds, collectCourseIds: courseIds })) throw invalidSource();
  let lockedSourceIds: string[] = [];
  const acquire = async () => {
    if (!await lockActiveMemoryCourses(tx, scope, [...courseIds])) throw invalidSource();
    lockedSourceIds = [...(await lockMemoryMaterialSources(tx, scope, sourceIds)).keys()];
    return lockedSourceIds;
  };
  if (!candidate.has_memory_dependencies) await acquire();
  const directDeadline = candidate.has_memory_dependencies
    ? (await readTurnMemoryDependencyDeadlines(tx, scope.workspaceId, [candidate.source_turn_id], { sourceIds, courseIds, acquire }))
      .get(candidate.source_turn_id) ?? -Infinity : Infinity;
  let hasAncestors = false;
  let historyDeadline = Infinity;
  if (historicalUserTurn) {
    const currentSources = new Set<string>(), currentCourses = new Set<string>();
    const history = await readTutorHistoryAncestorStatus(tx, scope, historicalUserTurn, {
      lockedSourceIds, collectSourceIds: currentSources, collectCourseIds: currentCourses,
    });
    if (!history.valid || [...currentCourses].some(id => !courseIds.has(id)) || [...currentSources].some(id => !lockedSourceIds.includes(id))) {
      throw invalidSource();
    }
    hasAncestors = history.hasAncestors;
    historyDeadline = history.earliestExpiresAtMs;
  }

  const admitted = await tx`
    SELECT c.id FROM opening_assistant_candidates c
    JOIN opening_turns t ON t.id = c.source_turn_id AND t.id = ${candidate.source_turn_id}
      AND t.workspace_id=c.workspace_id AND t.conversation_id=c.conversation_id AND t.status='complete'
    JOIN opening_conversations conv ON conv.id=t.conversation_id AND conv.workspace_id=t.workspace_id
      AND conv.owner_user_id=${scope.ownerUserId}
    LEFT JOIN opening_turns u ON t.role='assistant' AND u.id=(${pairedUserTurnId(tx, () => tx`t`)})
      AND u.workspace_id=t.workspace_id AND u.conversation_id=t.conversation_id AND u.role='user' AND u.status='complete'
    WHERE c.id = ${id} AND c.workspace_id = ${scope.workspaceId}
      AND NOT (${turnUsesInactiveMisconception(tx, "t", true)})
      AND jsonb_typeof(c.source_ids) = 'array'
      AND jsonb_typeof(t.source_versions) = 'object' AND jsonb_typeof(t.citations) = 'array'
      AND ${assistantCandidateSourcesVersioned(tx, scope.workspaceId)}
      AND ${turnHasOwnedSession(tx, () => tx`t`, () => tx`conv.owner_user_id`)}
      AND ${turnLineageCourse(tx, "t", () => tx`conv.course_id`, () => tx`conv.owner_user_id`)}
        IS NOT DISTINCT FROM ${candidate.course_id ?? null}::uuid
      AND u.id IS NOT DISTINCT FROM ${candidate.paired_user_turn_id ?? null}::uuid
      AND (u.id IS NULL OR (
        NOT (${pairedUserUsesInactiveMisconception(tx)})
        AND ${turnLineageCourse(tx, "u", () => tx`conv.course_id`, () => tx`conv.owner_user_id`)}
          IS NOT DISTINCT FROM ${candidate.user_course_id ?? null}::uuid
        AND ${taskTurnOriginActive(tx, scope.workspaceId, "u", () => tx`conv.course_id`,
          () => tx`conv.owner_user_id`, lockedSourceIds)}
      ))
      AND ${sourceMaterialsActive(tx, scope.workspaceId, () => candidateMaterialRows(tx, scope), {
        lockedSourceIds,
        memoryCourse: () => tx`${candidate.course_id ?? null}::uuid`,
        materialUse: candidate.material_use,
        directMaterialPolicy: true,
        authorizeMemoryOnlySeparately: true,
      })}
    FOR SHARE OF conv, t`;
  const refs = candidate.context_source_refs ?? (candidate.role === "assistant" ? null : []);
  const validRefs = parseContextMemoryDependencyIds(refs) !== null;
  if (!admitted.length || !validRefs) throw invalidSource();
  if (!(Math.min(directDeadline, historyDeadline) > Date.now())) {
    throw new OpeningPlanError("VALIDATION", "task candidate memory dependency is no longer active");
  }
  return candidate.has_memory_dependencies || hasAncestors || candidate.user_course_id || candidate.user_source_ids?.length
    ? candidate.source_turn_id : null;
}

/** Read-only so callers can repeat admission after locking the candidate. */
export async function assertTaskCandidateMemoryDependencies(
  tx: TransactionSql, workspaceId: string, dependencyTurnId: string | null,
): Promise<void> {
  if (dependencyTurnId === null) return;
  const deadlines = await readTurnMemoryDependencyDeadlines(tx, workspaceId, [dependencyTurnId], undefined,
    (scope, userTurnId) => readTutorHistoryAncestorStatus(tx, scope, userTurnId),
    () => tx`NOT (${turnUsesInactiveMisconception(tx, "a", true)})
      AND ${taskTurnOriginActive(tx, workspaceId, "a", () => tx`c.course_id`, () => tx`c.owner_user_id`)}
      AND (u.id IS NULL OR (NOT (${pairedUserUsesInactiveMisconception(tx)})
        AND ${taskTurnOriginActive(tx, workspaceId, "u", () => tx`c.course_id`, () => tx`c.owner_user_id`)}))`);
  if (!((deadlines.get(dependencyTurnId) ?? -Infinity) > Date.now())) {
    throw new OpeningPlanError("VALIDATION", "task candidate memory dependency is no longer active");
  }
}
