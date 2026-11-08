import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Scope } from "@aistudy/contracts";
import { z } from "zod";
import { learningDecisionInvalidation, NEXT_LEARNING_STEP_VERSION, validateLearningDecision, type LearnerState, type LearningDecision, type LearningDecisionInput,
  type LearningDecisionVersions } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { learningError, lockLearningOwner } from "./opening-learning-facts";
import { readOpeningLearnerState } from "./opening-learner-state-read";
import { readLearningGoal } from "./opening-learning-goals";

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

const firstLearningVersionSchema = z.object({ protocol: z.literal("first-learning-1"), courseId: z.string().uuid(),
  goalId: z.string().uuid(), createIntent: z.object({ source: z.literal("onboarding"), clientKey: z.string().uuid(),
    sourceIds: z.array(z.string().uuid()) }).passthrough(),
  plan: z.object({ startDate: z.string(), endDate: z.string(), timeZone: z.string(), taskKeys: z.array(z.string()) }).strict() }).strict();

/** Only this entry owns revalidation of its persisted initialization inputs. Never repairs old activities. */
async function explainFirstLearning(tx: TransactionSql, scope: Scope, decision: LearningDecision, state: LearnerState) {
  if (decision.layer !== "activity" || !/^first-learning-1\/next-learning-step-\d+$/.test(decision.policyVersion)) return null;
  let raw: unknown;
  try { raw = JSON.parse(decision.intentVersion); } catch { return null; }
  const parsed = firstLearningVersionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const captured = parsed.data;
  const [activity] = await tx`SELECT a.course_id,a.client_key,a.create_intent,a.source_ids,a.goal_json,c.archived_at
    FROM opening_teaching_activities a JOIN courses c ON c.id=a.course_id AND c.workspace_id=a.workspace_id
    WHERE a.id=${decision.targetId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  const { firstLearningPlan: plan, ...createIntent } = (activity?.create_intent ?? {}) as Row;
  const goalJson = (activity?.goal_json ?? {}) as Row;
  const identityMatches = activity?.course_id === captured.courseId
    && activity.client_key === `first-learning:${captured.createIntent.clientKey}:activity`
    && createIntent.source === "onboarding" && createIntent.clientKey === captured.createIntent.clientKey;
  const persistedIntent = { protocol: "first-learning-1", courseId: activity?.course_id ?? null,
    goalId: captured.goalId, createIntent, plan };
  // UUID identity is case-insensitive; keep submitted intent JSON untouched for replay equality.
  const activitySourceIds = new Set((activity?.source_ids as string[] | undefined ?? []).map(id => id.toLowerCase()));
  const capturedSourceIds = [...new Set(captured.createIntent.sourceIds.map(id => id.toLowerCase()))].sort();
  const sourcesMatch = isDeepStrictEqual([...activitySourceIds].sort(), capturedSourceIds);
  const goalMatches = goalJson.learningGoal === captured.createIntent.goal && goalJson.targetDate === captured.createIntent.targetDate;
  const intentVersion = identityMatches && sourcesMatch && goalMatches && isDeepStrictEqual(persistedIntent, raw)
    ? decision.intentVersion : "first-learning-persisted-intent-changed";
  const goal = await readLearningGoal(tx, scope, captured.goalId);
  const goalVersion = goal?.courseIds.includes(captured.courseId)
    ? `goal:${goal.id}:v${goal.revision}:${goal.lifecycle}` : "first-learning-goal-unavailable";
  const ids = capturedSourceIds.filter(id => Object.hasOwn(decision.sourceVersions, id));
  const sources = ids.length && identityMatches ? await tx`SELECT s.id,s.version FROM opening_sources s
    JOIN course_asset_memberships m ON m.asset_id=s.id AND m.workspace_id=s.workspace_id
      AND m.course_id=${captured.courseId} AND m.asset_type='source'
    WHERE s.workspace_id=${scope.workspaceId} AND s.id=ANY(${ids}::uuid[]) AND s.upload_state='uploaded'
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)` : [];
  const sourceVersions = structuredClone(state.sourceVersions);
  for (const id of ids) {
    const source = sources.find(row => String(row.id).toLowerCase() === id);
    sourceVersions[id] = source && activitySourceIds.has(id)
      ? [...new Set([...(sourceVersions[id] ?? []), Number(source.version)])].sort((a, b) => a - b) : [];
  }
  const invalidationReasons = learningDecisionInvalidation(decision, { stateVersion: state.stateVersion, sourceVersions,
    goalVersion, intentVersion, policyVersion: `first-learning-1/${NEXT_LEARNING_STEP_VERSION}` });
  if (!activity || activity.archived_at) invalidationReasons.push("course_unavailable");
  return { decision, current: invalidationReasons.length === 0, invalidationReasons, dataAsOf: state.dataAsOf };
}

/** Historical reasons stay historical; validity is rechecked without updating the receipt. */
export async function explainOpeningLearningDecision(tx: TransactionSql, scope: Scope, id: string,
  currentVersions?: Pick<LearningDecisionVersions, "goalVersion" | "intentVersion" | "policyVersion">) {
  const decision = await readOpeningLearningDecision(tx, scope, id);
  if (!decision) return null;
  const state = await readOpeningLearnerState(tx, scope);
  const firstLearning = await explainFirstLearning(tx, scope, decision, state);
  if (firstLearning) return firstLearning;
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
