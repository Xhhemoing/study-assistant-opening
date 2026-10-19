import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Scope } from "@aistudy/contracts";
import { learningDecisionInvalidation, validateLearningDecision, type LearningDecision, type LearningDecisionInput,
  type LearningDecisionVersions } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { learningError, lockLearningOwner } from "./opening-learning-facts";
import { readOpeningLearnerState } from "./opening-learner-state-read";

type Row = Record<string, unknown>;
function mapDecision(row: Row): LearningDecision {
  const receipt = row.receipt as LearningDecisionInput;
  validateLearningDecision(receipt);
  return { ...receipt, id: String(row.id), createdAt: new Date(row.created_at as Date).toISOString() };
}
export async function readOpeningLearningDecision(tx: TransactionSql, scope: Scope, id: string): Promise<LearningDecision | null> {
  const [row] = await tx`SELECT d.* FROM opening_learning_decisions d JOIN workspaces w ON w.id=d.workspace_id AND w.owner_user_id=d.owner_user_id
    WHERE d.id=${id} AND d.workspace_id=${scope.workspaceId} AND d.owner_user_id=${scope.ownerUserId}`;
  return row ? mapDecision(row) : null;
}

export async function readOpeningLearningDecisionByClientKey(tx: TransactionSql, scope: Scope, clientKey: string): Promise<LearningDecision | null> {
  const [row] = await tx`SELECT d.* FROM opening_learning_decisions d JOIN workspaces w ON w.id=d.workspace_id AND w.owner_user_id=d.owner_user_id
    WHERE d.client_key=${clientKey} AND d.workspace_id=${scope.workspaceId} AND d.owner_user_id=${scope.ownerUserId}`;
  return row ? mapDecision(row) : null;
}

/** Historical reasons stay historical; validity is rechecked without updating the receipt. */
export async function explainOpeningLearningDecision(tx: TransactionSql, scope: Scope, id: string,
  currentVersions?: Pick<LearningDecisionVersions, "goalVersion" | "intentVersion" | "policyVersion">) {
  const decision = await readOpeningLearningDecision(tx, scope, id);
  if (!decision) return null;
  const state = await readOpeningLearnerState(tx, scope);
  // The persisted session intent is authoritative even if a caller supplies an
  // older version. Activity receipts follow their exact parent session.
  const [intent] = decision.layer === "plan" ? [] : await tx`SELECT e.id,e.version
    FROM opening_study_intent_events e JOIN opening_learning_sessions s ON s.id=e.session_id
      AND s.workspace_id=e.workspace_id AND s.owner_user_id=e.owner_user_id
    WHERE e.workspace_id=${scope.workspaceId} AND e.owner_user_id=${scope.ownerUserId}
      AND ${decision.layer === "session" ? tx`s.id=${decision.targetId}` : tx`s.activity_id=${decision.targetId}`}
      AND ${decision.layer === "activity" && decision.parentDecisionId ? tx`EXISTS (
        SELECT 1 FROM opening_learning_decisions p WHERE p.id=${decision.parentDecisionId}
          AND p.workspace_id=e.workspace_id AND p.owner_user_id=e.owner_user_id
          AND p.layer='session' AND p.target_id=s.id)` : decision.layer === "activity" ? tx`NOT EXISTS (
        SELECT 1 FROM opening_learning_sessions other WHERE other.workspace_id=s.workspace_id
          AND other.owner_user_id=s.owner_user_id AND other.activity_id=s.activity_id AND other.id<>s.id)` : tx`TRUE`}
    ORDER BY e.version DESC LIMIT 1`;
  const intentVersion = intent ? `${String(intent.id)}:v${Number(intent.version)}` : currentVersions?.intentVersion;
  const invalidationReasons = learningDecisionInvalidation(decision, { stateVersion: state.stateVersion, sourceVersions: state.sourceVersions,
    goalVersion: currentVersions?.goalVersion ?? decision.goalVersion, intentVersion: intentVersion ?? decision.intentVersion,
    policyVersion: currentVersions?.policyVersion ?? decision.policyVersion });
  if (!currentVersions) {
    if (decision.invalidationConditions.includes("goal_changed") || (!intent && decision.invalidationConditions.includes("intent_changed"))) invalidationReasons.push("goal_intent_versions_not_revalidated");
    if (decision.invalidationConditions.includes("policy_changed")) invalidationReasons.push("policy_version_not_revalidated");
  }
  return { decision, current: invalidationReasons.length === 0, invalidationReasons, dataAsOf: state.dataAsOf };
}

export function createOpeningLearningDecisionsRepository(sql: Sql) {
  return {
    /** Only server-selected actions may call record. Models never own these facts. */
    async record(scope: Scope, input: LearningDecisionInput, clientKey: string): Promise<LearningDecision> {
      validateLearningDecision(input);
      if (!clientKey || clientKey.length > 300) throw learningError("VALIDATION", "invalid decision client key");
      return sql.begin(tx => recordOpeningLearningDecision(tx, scope, input, clientKey)) as Promise<LearningDecision>;
    },
    get: (scope: Scope, id: string): Promise<LearningDecision | null> => sql.begin("isolation level repeatable read read only", tx => readOpeningLearningDecision(tx, scope, id)) as Promise<LearningDecision | null>,
    explain: (scope: Scope, id: string, currentVersions?: Pick<LearningDecisionVersions, "goalVersion" | "intentVersion" | "policyVersion">) => sql.begin("isolation level repeatable read read only", tx => explainOpeningLearningDecision(tx, scope, id, currentVersions)),
    list: (scope: Scope, input: { layer: "plan" | "session" | "activity"; targetId: string }) => sql.begin("isolation level repeatable read read only", async tx => {
      const rows = await tx`SELECT d.* FROM opening_learning_decisions d JOIN workspaces w ON w.id=d.workspace_id AND w.owner_user_id=d.owner_user_id
        WHERE d.workspace_id=${scope.workspaceId} AND d.owner_user_id=${scope.ownerUserId} AND d.layer=${input.layer} AND d.target_id=${input.targetId}
        ORDER BY created_at DESC,id DESC LIMIT 100`;
      return rows.map(mapDecision);
    }),
  };
}

/** Transaction adapter for canonical server action creation; no independent commit. */
export async function recordOpeningLearningDecision(tx: TransactionSql, scope: Scope, input: LearningDecisionInput, clientKey: string): Promise<LearningDecision> {
  validateLearningDecision(input);
  if (!clientKey || clientKey.length > 300) throw learningError("VALIDATION", "invalid decision client key");
  await lockLearningOwner(tx, scope);
  const existing = await tx`SELECT * FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey}`;
  if (existing[0]) {
    if (!isDeepStrictEqual(existing[0].receipt, input)) throw learningError("CONFLICT", "decision key reused for different input");
    return mapDecision(existing[0]);
  }
  const targetTable = input.layer === "plan" ? "opening_plan_drafts" : input.layer === "session" ? "opening_learning_sessions" : "opening_teaching_activities";
  const targets = await tx.unsafe(`SELECT id FROM ${targetTable} WHERE id=$1 AND workspace_id=$2 AND owner_user_id=$3 FOR SHARE`,
    [input.targetId, scope.workspaceId, scope.ownerUserId]);
  if (!targets.length) throw learningError("NOT_FOUND", "decision target not found");
  if (input.parentDecisionId) {
    const parent = await readOpeningLearningDecision(tx, scope, input.parentDecisionId);
    const expected = input.layer === "activity" ? "session" : "plan";
    if (!parent || parent.layer !== expected) throw learningError("VALIDATION", "decision parent scope or layer mismatch");
    if (input.layer === "activity") {
      const [session] = await tx`SELECT activity_id FROM opening_learning_sessions WHERE id=${parent.targetId}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      if (!session || session.activity_id !== input.targetId) throw learningError("VALIDATION", "activity decision does not belong to parent session");
    }
  }
  const [row] = await tx`INSERT INTO opening_learning_decisions(id,workspace_id,owner_user_id,layer,target_id,parent_decision_id,client_key,receipt)
    VALUES (${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${input.layer},${input.targetId},${input.parentDecisionId ?? null},${clientKey},${tx.json(input as never)})
    ON CONFLICT(workspace_id,owner_user_id,client_key) DO NOTHING RETURNING *`;
  if (row) return mapDecision(row);
  const [replay] = await tx`SELECT * FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey}`;
  if (!replay || !isDeepStrictEqual(replay.receipt, input)) throw learningError("CONFLICT", "decision key reused for different input");
  return mapDecision(replay);
}
