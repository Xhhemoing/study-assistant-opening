import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql } from "postgres";
import { suggestedTaskSchema, suggestionFeedbackInputSchema, type Scope, type SuggestedTask, type SuggestionFeedbackInput, type SuggestionFeedbackResult } from "@aistudy/contracts";
import { suggestionFeedbackIdentity, withOpeningSuggestionFeedback } from "@aistudy/domain";
import { dailyDraftAdvisoryLockKeys, mapOpeningPlanDraft } from "./opening-plans";
import { lockWorkspaceLearningHistory, type LearningSql } from "./opening-learning-facts";
import { OpeningPlanError } from "./opening-plan-error";

export async function readOpeningSuppressedSuggestionIdentities(db: LearningSql, scope: Scope, day: string): Promise<string[]> {
  const rows = await db`SELECT identity FROM opening_suggestion_feedback
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND day=${day}::date`;
  return rows.map(row => String(row.identity));
}

/** Called inside acceptance's existing day/history/workspace/draft locks. Never silently drops a selection. */
export async function assertOpeningSuggestedSelectionAllowed(db: LearningSql, scope: Scope, day: string, selected: readonly SuggestedTask[]) {
  if (!selected.length) return;
  const suppressed = new Set(await readOpeningSuppressedSuggestionIdentities(db, scope, day));
  if (selected.some(item => suppressed.has(suggestionFeedbackIdentity(item)))) {
    throw new OpeningPlanError("CONFLICT", "a selected suggestion was declined; refresh", "selection_mismatch");
  }
}

/** Explicit planning feedback, atomically versioned; neither learning facts nor accepted blocks are changed. */
export async function recordOpeningSuggestionFeedback(sql: Sql, scope: Scope, raw: SuggestionFeedbackInput): Promise<SuggestionFeedbackResult> {
  const input = suggestionFeedbackInputSchema.parse(raw);
  const intent = { draftId: input.draftId, expectedDraftVersion: input.expectedDraftVersion,
    suggestionKey: input.suggestionKey, reason: input.reason ?? null };
  return sql.begin(async tx => {
    const [located] = await tx`SELECT day FROM opening_plan_drafts
      WHERE id=${input.draftId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if (!located) throw new OpeningPlanError("NOT_FOUND", "draft not found");
    const day = new Date(located.day as string | Date).toISOString().slice(0, 10);
    const [a, b] = dailyDraftAdvisoryLockKeys(scope.workspaceId, day);
    await tx`SELECT pg_advisory_xact_lock(${a}, ${b})`;
    await lockWorkspaceLearningHistory(tx, scope);
    const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    if (!owners.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
    const [draft] = await tx`SELECT * FROM opening_plan_drafts
      WHERE id=${input.draftId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    if (!draft) throw new OpeningPlanError("NOT_FOUND", "draft not found");
    const [prior] = await tx`SELECT id,intent FROM opening_suggestion_feedback
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
    if (prior) {
      if (!isDeepStrictEqual(prior.intent, intent)) throw new OpeningPlanError("CONFLICT", "clientKey intent differs", "selection_mismatch");
      return { feedbackId: String(prior.id), draft: withOpeningSuggestionFeedback(mapOpeningPlanDraft(draft),
        await readOpeningSuppressedSuggestionIdentities(tx, scope, day)) };
    }
    if (draft.status !== "draft" || Number(draft.version) !== input.expectedDraftVersion) {
      throw new OpeningPlanError("CONFLICT", "draft changed; refresh", "stale_version");
    }
    if (draft.origin === "agent") throw new OpeningPlanError("VALIDATION", "conversation suggestions use their candidate controls");
    const suggestion = suggestedTaskSchema.array().parse(draft.suggested_tasks ?? []).find(item => item.key === input.suggestionKey);
    if (!suggestion) throw new OpeningPlanError("VALIDATION", "suggestion is not part of this draft");
    const identity = suggestionFeedbackIdentity(suggestion);
    const [existing] = await tx`SELECT id FROM opening_suggestion_feedback
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND day=${day}::date AND identity=${identity}`;
    if (existing) throw new OpeningPlanError("CONFLICT", "suggestion already declined today; refresh", "selection_mismatch");
    const id = randomUUID();
    await tx`INSERT INTO opening_suggestion_feedback
      (id,workspace_id,owner_user_id,draft_id,day,suggestion_key,identity,suggestion_kind,course_id,requirement_key,reason,client_key,intent)
      VALUES(${id},${scope.workspaceId},${scope.ownerUserId},${input.draftId},${day}::date,${suggestion.key},${identity},
        ${suggestion.kind},${suggestion.courseId},${suggestion.requirementKey ?? null},${input.reason ?? null},${input.clientKey},${tx.json(intent)})`;
    const [updated] = await tx`UPDATE opening_plan_drafts SET version=version+1,updated_at=now()
      WHERE id=${input.draftId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND status='draft' AND version=${input.expectedDraftVersion} RETURNING *`;
    if (!updated) throw new OpeningPlanError("CONFLICT", "draft changed; refresh", "stale_version");
    return { feedbackId: id, draft: withOpeningSuggestionFeedback(mapOpeningPlanDraft(updated),
      await readOpeningSuppressedSuggestionIdentities(tx, scope, day)) };
  });
}
