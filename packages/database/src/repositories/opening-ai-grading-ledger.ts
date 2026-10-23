import type { Sql, TransactionSql } from "postgres";
import type { Scope } from "@aistudy/contracts";

export type GradingLedgerState = "unsent" | "in_flight" | "unknown" | "completed" | "blocked";

/** Grading-only replay: a confirmed release authorizes no send on this key.
 * Return its receipt before current model/price terms reach reserve's immutable
 * snapshot check. Scope, purpose and any pinned parent must still match; all
 * other states go through the unmodified budget repository. */
export async function readOpeningAiGradingReleasedReservation(db: Sql | TransactionSql, scope: Scope,
  input: { requestId: string; purpose: string; parentBudget?: { id: string } }) {
  const [row] = await db`SELECT id,release_reason FROM opening_budget_reservations
    WHERE workspace_id=${scope.workspaceId} AND request_id=${input.requestId} AND purpose=${input.purpose}
      AND (parent_interaction_id IS NULL OR parent_interaction_id=${input.parentBudget?.id ?? null})
      AND state='released' AND release_reason IN ('not_sent','cancelled')
      AND outcome_unknown_at IS NULL AND COALESCE(pending_reconcile_cents,0)=0
      AND EXISTS (SELECT 1 FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId})`;
  return row ? { id: String(row.id), state: "released" as const, releaseReason: String(row.release_reason) } : null;
}
/** Inspect the entire deterministic retry/fallback family, including legacy keys.
 * A released primary is not permission to resend an unknown fallback. */
export async function readOpeningAiGradingLedger(db: Sql | TransactionSql, scope: Scope, operationId: string): Promise<GradingLedgerState> {
  const rows = await db`SELECT state,execution_claimed_at,outcome_unknown_at,reconciled_at,pending_reconcile_cents,release_reason
    FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId}
      AND (request_id=${operationId} OR left(request_id,length(${operationId})+1)=${operationId + ":"})
      AND EXISTS (SELECT 1 FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId})`;
  if (rows.some(row => row.outcome_unknown_at != null || Number(row.pending_reconcile_cents ?? 0) > 0)) return "unknown";
  if (rows.some(row => row.state === "reserved" && row.execution_claimed_at != null)) return "in_flight";
  if (rows.some(row => row.state === "completed")) return "completed";
  if (rows.some(row => row.state === "released" && !["not_sent", "cancelled"].includes(String(row.release_reason)))) return "blocked";
  return "unsent";
}
