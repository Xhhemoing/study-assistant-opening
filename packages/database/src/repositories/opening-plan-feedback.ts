import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { planFeedbackSummarySchema, type PlanFeedbackSummary, type TaskFeedbackInput } from "@aistudy/contracts";
import { plannerSuggestionKind } from "./opening-task-fields";
import type { OpeningScope } from "./opening-sources";

/** Called only inside the transaction that changed the owned task. */
export async function recordOpeningPlanFeedback(
  tx: TransactionSql,
  scope: OpeningScope,
  task: Record<string, unknown>,
  action: "done" | "skipped" | "deferred" | "resumed",
  feedback?: TaskFeedbackInput,
): Promise<void> {
  await tx`INSERT INTO opening_plan_feedback
    (id, workspace_id, owner_user_id, task_id, task_version, action, reason,
      origin, requirement_key, suggestion_kind, not_before)
    VALUES (${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${String(task.id)},
      ${Number(task.version)}, ${action}, ${feedback?.reason ?? null}, ${String(task.origin ?? "manual")},
      ${(task.requirement_key as string | null) ?? null}, ${plannerSuggestionKind(task) ?? null},
      ${(task.not_before as string | Date | null) ?? null})`;
}

/** Half-open server-recorded interval. Missing historical events remain unknown. */
export async function readOpeningPlanFeedbackSummary(
  sql: Sql,
  scope: OpeningScope,
  from: Date,
  until: Date,
): Promise<PlanFeedbackSummary> {
  const rows = await sql`SELECT action, reason, count(*)::int AS n FROM opening_plan_feedback
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND recorded_at >= ${from} AND recorded_at < ${until}
    GROUP BY action, reason`;
  const result: PlanFeedbackSummary = {
    from: from.toISOString(), until: until.toISOString(),
    actions: { done: 0, skipped: 0, deferred: 0, resumed: 0 },
    reasons: { eligible: 0, supplied: 0, declined: 0, missing: 0, coverage: null,
      counts: { time_short: 0, too_hard: 0, too_easy: 0, not_relevant: 0, other: 0 } },
    historicalActions: "unknown",
  };
  for (const row of rows) {
    const action = row.action as keyof typeof result.actions;
    const n = Number(row.n);
    result.actions[action] += n;
    if (action !== "skipped" && action !== "deferred") continue;
    result.reasons.eligible += n;
    if (row.reason == null) result.reasons.missing += n;
    else if (row.reason === "prefer_not_say") result.reasons.declined += n;
    else {
      result.reasons.supplied += n;
      result.reasons.counts[row.reason as keyof typeof result.reasons.counts] += n;
    }
  }
  if (result.reasons.eligible > 0) result.reasons.coverage = result.reasons.supplied / result.reasons.eligible;
  return planFeedbackSummarySchema.parse(result);
}
