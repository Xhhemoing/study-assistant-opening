import type { Sql } from "postgres";
import { systemQueryReceiptSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { createOpeningPrivacyRepository } from "./opening-privacy";

import { contextSourceRefsIncluded, mergeContextSourceRefs, parseContextSourceRefs, turnContextSourceRefs, type ContextSourceRef } from "./opening-context-provenance";
type HistoryTurn = { role: "user" | "assistant"; text: string };
export type TutorHistoryPurpose = "model" | "record_referents";

/** Completed exchanges only. A revoked or excluded ancestor invalidates all derived history. */
export async function loadTutorHistoryContext(sql: Sql, scope: OpeningScope, currentTurnId: string, purpose: TutorHistoryPurpose = "model"): Promise<{ history: HistoryTurn[]; sourceRefs: ContextSourceRef[] }> {
  const recordReferents = purpose === "record_referents";
  const excludedSourceIds = await createOpeningPrivacyRepository(sql).listExcludedSourceIds(scope);
  const rows = await sql`
    WITH prior AS (
      SELECT u.text AS question, a.text AS answer, u.created_at, u.id,
        a.query_system, a.system_query, w.privacy_epoch AS current_privacy_epoch,
        ${turnContextSourceRefs(sql, "u")} AS user_source_refs,
        ${turnContextSourceRefs(sql, "a")} AS assistant_source_refs,
        EXISTS (
          SELECT 1 FROM unnest(u.source_ids || a.source_ids) AS ref(id)
          WHERE NOT EXISTS (SELECT 1 FROM opening_sources s WHERE s.id=ref.id
            AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded')
        ) OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(a.citations) AS citation
          WHERE NOT EXISTS (SELECT 1 FROM opening_sources s
            WHERE s.id::text=citation->>'sourceId' AND s.workspace_id=${scope.workspaceId}
              AND s.upload_state='uploaded' AND s.version::text=citation->>'sourceVersion')
        ) OR EXISTS (
          SELECT 1 FROM unnest(u.source_ids || a.source_ids || current.source_ids) AS ref(id)
          WHERE ref.id = ANY(${excludedSourceIds}::uuid[])
        ) OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(a.citations) AS citation
          WHERE citation->>'sourceId' = ANY(${excludedSourceIds}::text[])
        ) OR NOT (${contextSourceRefsIncluded(sql, scope.workspaceId, turnContextSourceRefs(sql, "u"))})
          OR NOT (${contextSourceRefsIncluded(sql, scope.workspaceId, turnContextSourceRefs(sql, "a"))}) AS invalid
      FROM opening_turns current
      JOIN opening_conversations c ON c.id=current.conversation_id
      JOIN workspaces w ON w.id=c.workspace_id
      JOIN opening_tutor_jobs j ON j.conversation_id=c.id AND j.workspace_id=c.workspace_id
      JOIN opening_turns u ON u.id=j.user_turn_id AND u.workspace_id=c.workspace_id
      JOIN opening_turns a ON a.id=j.assistant_turn_id AND a.workspace_id=c.workspace_id
      WHERE current.id=${currentTurnId} AND current.role='user'
        AND current.workspace_id=${scope.workspaceId} AND c.workspace_id=${scope.workspaceId}
        AND c.owner_user_id=${scope.ownerUserId}
        AND u.created_at < current.created_at AND u.status='complete' AND a.status='complete'
        -- Query snapshots are separate authority records, including legacy imported receipts.
        -- Never promote their text into a later ordinary model conversation.
        AND (${recordReferents} OR (NOT u.query_system AND NOT a.query_system AND a.system_query IS NULL))
    )
    SELECT left(question,12001) AS question,
      CASE WHEN ${recordReferents} THEN '' ELSE left(answer,12001) END AS answer,
      user_source_refs, assistant_source_refs, query_system, system_query, current_privacy_epoch
    FROM prior WHERE NOT EXISTS (SELECT 1 FROM prior WHERE invalid)
    ORDER BY created_at DESC, id DESC LIMIT 20
  `;
  const history: HistoryTurn[] = [];
  let characters = 0;
  const sourceRefs: ContextSourceRef[] = [];
  for (const row of rows) {
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
    // Record follow-ups inherit the user's referent, never prior assistant claims.
    if (recordReferents) history.unshift({ role: "user", text: question });
    else history.unshift({ role: "user", text: question }, { role: "assistant", text: answer });
    sourceRefs.push(...(parseContextSourceRefs(row.user_source_refs) ?? []), ...(parseContextSourceRefs(row.assistant_source_refs) ?? []));
    characters += question.length + answer.length;
  }
  return { history, sourceRefs: mergeContextSourceRefs(sourceRefs) };
}

/** Compatibility projection for callers that do not send or persist model context. */
export async function loadTutorHistory(sql: Sql, scope: OpeningScope, currentTurnId: string): Promise<HistoryTurn[]> {
  return (await loadTutorHistoryContext(sql, scope, currentTurnId)).history;
}
