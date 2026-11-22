import type { Sql } from "postgres";
import { systemQueryReceiptSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { createOpeningPrivacyRepository } from "./opening-privacy";

import {
  contextSourceRefsIncluded, lineageUuid, mergeContextSourceRefs, resolveMemoryDependencyStatus,
  parseContextMemoryDependencyIds, parseContextSourceRefs, turnContextSourceRefs, turnMemoryOnlyBackingIds,
  type ContextSourceRef, type FragmentFactory,
} from "./opening-context-provenance";
import { readMemoryDependencyStatus } from "./opening-memory-admission";

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
    WITH prior AS MATERIALIZED (
      SELECT u.id, a.id AS assistant_id, u.created_at,
        a.query_system, a.system_query, w.privacy_epoch AS current_privacy_epoch,
        refs.user_refs AS user_source_refs, refs.assistant_refs AS assistant_source_refs,
        ${priorCourse()} AS prior_course_id, ${currentCourse()} AS current_course_id,
        CASE WHEN current.attempt_id IS NOT NULL OR current.context_anchor->>'itemVersionId' IS NOT NULL
          THEN 'practice' ELSE 'citation' END AS material_use,
        CASE WHEN u.attempt_id IS NOT NULL OR u.context_anchor->>'itemVersionId' IS NOT NULL
          THEN 'practice' ELSE 'citation' END AS prior_material_use,
        CASE WHEN a.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
          THEN ${turnMemoryOnlyBackingIds(sql, () => sql`a.context_source_refs`, priorCourse, scope)} ELSE '[]'::jsonb END AS memory_backing_ids,
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
      SELECT prior.*, count(*) FILTER (WHERE NOT memory_bearing) OVER exchange_order AS ordinary_rank
      FROM prior WINDOW exchange_order AS (ORDER BY created_at DESC, id DESC)
    )
    SELECT id, assistant_id,
      user_source_refs, assistant_source_refs, prior_course_id, current_course_id, memory_backing_ids,
      query_system, system_query, current_privacy_epoch, material_use, prior_material_use
    FROM ranked WHERE (memory_bearing OR ordinary_rank <= 20) AND NOT EXISTS (SELECT 1 FROM prior WHERE invalid)
    ORDER BY created_at DESC, id DESC
  `;
  const lineage = rows.map(row => {
    const ids = row.assistant_source_refs === undefined ? [] : parseContextMemoryDependencyIds(row.assistant_source_refs);
    const backings = row.memory_backing_ids as string[][] | undefined;
    return { ids, backings, priorUse: row.prior_material_use === "practice" ? "practice" as const : "citation" as const };
  });
  if (lineage.some(row => row.ids === null)) return { history: [], sourceRefs: [] };
  const materialUse = rows[0]?.material_use === "practice" ? "practice" : "citation";
  const graphs = await Promise.all((["citation", "practice"] as const).map(async use => {
    const roots = [...new Set(lineage.flatMap(row => row.backings && (row.priorUse === use || materialUse === use)
      ? [...row.ids!, ...row.backings.flat()] : []))];
    return readMemoryDependencyStatus(sql, scope, roots, { excluded: excludedSourceIds, materialUse: use });
  }));
  const graphFor = (use: "citation" | "practice") => graphs[use === "practice" ? 1 : 0]!;
  const resolved = lineage.map(({ ids, backings, priorUse }, index) => {
    const row = rows[index]!;
    const own = backings ? resolveMemoryDependencyStatus(graphFor(priorUse), ids!, backings, row.prior_course_id as string | null) : [];
    if (!own) return null;
    const inCourse = own.every(node => node.course_id === null || node.course_id === row.current_course_id);
    const current = inCourse && backings && materialUse !== priorUse
      ? resolveMemoryDependencyStatus(graphFor(materialUse), ids!, backings, row.current_course_id as string | null) : own;
    return { ids: [...ids!, ...(current ?? []).map(node => node.dep_id)], inScope: inCourse && current !== null,
      ownExpirations: own.flatMap(node => node.expires_at === null ? [] : [node.expires_at]),
      expirations: (current ?? []).flatMap(node => node.expires_at === null ? [] : [node.expires_at]) };
  });
  if (resolved.some(item => item === null)) return { history: [], sourceRefs: [] };
  const selected = rows.flatMap((row, index) => resolved[index]!.inScope ? [{ row, dependencies: resolved[index]! }] : []).slice(0, 20);
  const textIds = selected.flatMap(({ row }) => typeof row.id === "string"
    ? (recordReferents ? [row.id] : [row.id, String(row.assistant_id)]) : []);
  const texts = textIds.length ? await sql<{ id: string; text: string }[]>`
    SELECT id, left(text, 12001) AS text FROM opening_turns
    WHERE workspace_id=${scope.workspaceId} AND id=ANY(${textIds}::uuid[]) AND status='complete'` : [];
  const textById = new Map(texts.map(row => [row.id, row.text]));
  const nowMs = Date.now();
  if (resolved.some(item => item!.ownExpirations.some(expiry => !(new Date(expiry).getTime() > nowMs)))) {
    return { history: [], sourceRefs: [] };
  }
  const history: HistoryTurn[] = [];
  let characters = 0;
  const sourceRefs: ContextSourceRef[] = [];
  const memoryIdSet = new Set<string>();
  let earliestTempExpiresAtMs: number | undefined;
  let earliestTempExpiresAtIso: string | undefined;
  for (const { row, dependencies } of selected) {
    if (dependencies.expirations.some(expiry => !(new Date(expiry).getTime() > nowMs))) continue;
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
    const question = row.question ?? textById.get(String(row.id));
    const answer = recordReferents ? "" : (row.answer ?? textById.get(String(row.assistant_id)));
    if (typeof question !== "string" || typeof answer !== "string") return { history: [], sourceRefs: [] };
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
