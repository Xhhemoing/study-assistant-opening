import type { Sql } from "postgres";
import { systemQueryReceiptSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { createOpeningPrivacyRepository } from "./opening-privacy";

import {
  contextSourceRefsIncluded, lineageUuid, mergeContextSourceRefs, readMemoryDependencyStatus, resolveMemoryDependencyStatus,
  parseContextMemoryDependencyIds, parseContextSourceRefs, turnContextSourceRefs, turnMemoryOnlyBackingIds,
  type ContextSourceRef, type FragmentFactory,
} from "./opening-context-provenance";
type HistoryTurn = { role: "user" | "assistant"; text: string };
export type TutorHistoryPurpose = "model" | "record_referents";
export type TutorHistoryContext = {
  history: HistoryTurn[];
  sourceRefs: ContextSourceRef[];
  memoryIds?: string[];
  temporaryMemoryExpiresAt?: string;
};

/** Completed exchanges only. A revoked or excluded ancestor invalidates all derived history. */
export async function loadTutorHistoryContext(sql: Sql, scope: OpeningScope, currentTurnId: string, purpose: TutorHistoryPurpose = "model"): Promise<TutorHistoryContext> {
  const recordReferents = purpose === "record_referents";
  const excludedSourceIds = await createOpeningPrivacyRepository(sql).listExcludedSourceIds(scope);
  const priorCourse: FragmentFactory = () => sql`COALESCE(c.course_id, ${lineageUuid(sql, () => sql`u.context_anchor->>'courseId'`)})`;
  const currentCourse: FragmentFactory = () => sql`COALESCE(c.course_id, ${lineageUuid(sql, () => sql`current.context_anchor->>'courseId'`)})`;
  const rows = await sql`
    WITH prior AS (
      SELECT u.text AS question, a.text AS answer, u.created_at, u.id,
        a.query_system, a.system_query, w.privacy_epoch AS current_privacy_epoch,
        refs.user_refs AS user_source_refs, refs.assistant_refs AS assistant_source_refs,
        ${priorCourse()} AS prior_course_id, ${currentCourse()} AS current_course_id,
        ${turnMemoryOnlyBackingIds(sql, () => sql`a.context_source_refs`, priorCourse, scope)} AS memory_backing_ids,
        COALESCE(a.context_source_refs @? '$[*].memoryDependencyIds[*]' OR
          a.context_source_refs @> '[{"memoryOnly":true}]'::jsonb, false) AS memory_bearing,
        EXISTS (
          SELECT 1 FROM unnest(u.source_ids || a.source_ids || current.source_ids) AS ref(id)
          WHERE ref.id = ANY(${excludedSourceIds}::uuid[])
        ) OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(a.citations) AS citation
          WHERE citation->>'sourceId' = ANY(${excludedSourceIds}::text[])
        ) OR NOT (${contextSourceRefsIncluded(sql, scope.workspaceId, () => sql`refs.user_refs || refs.assistant_refs || a.citations`,
          false, true, () => sql`u.source_ids || a.source_ids`)}) AS invalid
      FROM opening_turns current
      JOIN opening_conversations c ON c.id=current.conversation_id
      JOIN workspaces w ON w.id=c.workspace_id
      JOIN opening_tutor_jobs j ON j.conversation_id=c.id AND j.workspace_id=c.workspace_id
      JOIN opening_turns u ON u.id=j.user_turn_id AND u.workspace_id=c.workspace_id AND u.conversation_id=c.id AND u.role='user'
      JOIN opening_turns a ON a.id=j.assistant_turn_id AND a.workspace_id=c.workspace_id AND a.conversation_id=c.id AND a.role='assistant'
      CROSS JOIN LATERAL (SELECT ${turnContextSourceRefs(sql, "u")} AS user_refs,
        ${turnContextSourceRefs(sql, "a")} AS assistant_refs) refs
      WHERE current.id=${currentTurnId} AND current.role='user'
        AND current.workspace_id=${scope.workspaceId} AND c.workspace_id=${scope.workspaceId}
        AND c.owner_user_id=${scope.ownerUserId}
        AND u.created_at < current.created_at AND u.status='complete' AND a.status='complete'
        -- Query snapshots are separate authority records, including legacy imported receipts.
        -- Never promote their text into a later ordinary model conversation.
        AND (${recordReferents} OR (NOT u.query_system AND NOT a.query_system AND a.system_query IS NULL))
    ), ranked AS (
      SELECT prior.*, count(*) FILTER (WHERE NOT memory_bearing) OVER (ORDER BY created_at DESC, id DESC) AS ordinary_rank
      FROM prior
    )
    SELECT left(question,12001) AS question,
      CASE WHEN ${recordReferents} THEN '' ELSE left(answer,12001) END AS answer,
      user_source_refs, assistant_source_refs, prior_course_id, current_course_id, memory_backing_ids,
      query_system, system_query, current_privacy_epoch
    FROM ranked WHERE (memory_bearing OR ordinary_rank <= 20) AND NOT EXISTS (SELECT 1 FROM prior WHERE invalid)
    ORDER BY created_at DESC, id DESC
  `;
  const lineage = rows.map(row => {
    const ids = row.assistant_source_refs === undefined ? [] : parseContextMemoryDependencyIds(row.assistant_source_refs);
    const backings = row.memory_backing_ids as string[][] | undefined;
    return { ids, backings };
  });
  const roots = [...new Set(lineage.flatMap(row => row.backings ? [...(row.ids ?? []), ...row.backings.flat()] : []))];
  const graph = await readMemoryDependencyStatus(sql, scope.workspaceId, roots);
  const resolved = lineage.map(({ ids, backings }, index) => {
    if (!ids) return null;
    const row = rows[index]!;
    const nodes = backings ? resolveMemoryDependencyStatus(graph, ids, backings, row.prior_course_id as string | null) : [];
    if (!nodes) return null;
    return { ids: [...ids, ...nodes.map(node => node.dep_id)],
      inScope: nodes.every(node => node.course_id === null || node.course_id === row.current_course_id),
      expirations: nodes.flatMap(node => node.expires_at === null ? [] : [node.expires_at]) };
  });
  if (resolved.some(item => item === null)) return { history: [], sourceRefs: [] };
  const history: HistoryTurn[] = [];
  let characters = 0;
  const sourceRefs: ContextSourceRef[] = [];
  const memoryIdSet = new Set<string>();
  let earliestTempExpiresAtMs: number | undefined;
  let earliestTempExpiresAtIso: string | undefined;
  const nowMs = Date.now();
  for (const [index, row] of rows.entries()) {
    const dependencies = resolved[index]!;
    if (!dependencies.inScope) continue;
    if (history.length >= (recordReferents ? 20 : 40)) break;
    if (recordReferents && (row.query_system || row.system_query != null)) {
      const receipt = systemQueryReceiptSchema.safeParse(row.system_query);
      const lineage = parseContextSourceRefs(row.assistant_source_refs) ?? [];
      if (!receipt.success || receipt.data.authorization.purpose !== "system_record_lookup"
        || receipt.data.authorization.workspaceId !== scope.workspaceId
        || receipt.data.authorization.principalId !== scope.ownerUserId
        || receipt.data.privacyEpoch !== Number(row.current_privacy_epoch)
        || receipt.data.results.some(result => result.sourceRefs.some(ref =>
          !lineage.some(parent => parent.sourceId === ref.sourceId.toLowerCase() && parent.sourceVersion === ref.sourceVersion)))) {
        return { history: [], sourceRefs: [] };
      }
    }
    const question = row.question as string;
    const answer = recordReferents ? "" : row.answer as string;
    if (characters + question.length + answer.length > 12_000) break;
    const expirations = [...dependencies.expirations, ...(row.memory_temporary_expires_at == null
      ? [] : [row.memory_temporary_expires_at as Date | string])];
    for (const expiry of expirations) {
      const parsedDate = new Date(expiry);
      const parsedMs = parsedDate.getTime();
      if (Number.isNaN(parsedMs) || parsedMs <= nowMs) return { history: [], sourceRefs: [] };
      if (earliestTempExpiresAtMs === undefined || parsedMs < earliestTempExpiresAtMs) {
        earliestTempExpiresAtMs = parsedMs;
        earliestTempExpiresAtIso = parsedDate.toISOString();
      }
    }
    // Record follow-ups inherit the user's referent, never prior assistant claims.
    if (recordReferents) history.unshift({ role: "user", text: question });
    else history.unshift({ role: "user", text: question }, { role: "assistant", text: answer });
    sourceRefs.push(...(parseContextSourceRefs(row.user_source_refs) ?? []), ...(parseContextSourceRefs(row.assistant_source_refs) ?? []));
    const ancestorMemoryIds = parseContextMemoryDependencyIds([{ memoryDependencyIds: row.memory_dependency_ids }]) ?? [];
    for (const memoryId of [...dependencies.ids, ...ancestorMemoryIds]) memoryIdSet.add(memoryId);
    characters += question.length + answer.length;
  }
  const memoryIds = [...memoryIdSet].sort();
  return {
    history,
    sourceRefs: mergeContextSourceRefs(sourceRefs),
    ...(memoryIds.length ? { memoryIds } : {}),
    ...(earliestTempExpiresAtIso ? { temporaryMemoryExpiresAt: earliestTempExpiresAtIso } : {}),
  };
}

/** Compatibility projection for callers that do not send or persist model context. */
export async function loadTutorHistory(sql: Sql, scope: OpeningScope, currentTurnId: string): Promise<HistoryTurn[]> {
  return (await loadTutorHistoryContext(sql, scope, currentTurnId)).history;
}
