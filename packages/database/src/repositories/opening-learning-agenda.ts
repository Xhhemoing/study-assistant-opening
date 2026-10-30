import type { Scope, LearningAgenda } from "@aistudy/contracts";
import { isDeepStrictEqual } from "node:util";
import { assembleLearningAgenda, learningDecisionInvalidation, nextLearningStep, SPAN_REQUIREMENT_KEY, type LearningDecision, type NextLearningStepInput } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { readOpeningLearningDecision } from "./opening-learning-decisions";
import { readOpeningLearnerState } from "./opening-learner-state-read";
import { readSpanTutorAuthorization } from "./opening-span-tutor-grant";
import { assertOpeningCourseRouteCurrent } from "./opening-course-route-origin";
import { readLearningGoal } from "./opening-learning-goals";
import { SPAN_TUTOR_EXECUTION_POLICY_VERSION } from "./opening-span-tutor-context";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : null;
/** Same transaction, exact persisted session, no activity/job/budget writes. */
export async function readOpeningLearningAgenda(tx: TransactionSql, scope: Scope, courseId: string, activityId?: string | null): Promise<LearningAgenda | null> {
  const [activity] = await tx`SELECT a.*,s.id AS session_id,s.skill_label,c.archived_at
    FROM opening_teaching_activities a
    JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
    JOIN courses c ON c.id=a.course_id AND c.workspace_id=a.workspace_id
    LEFT JOIN opening_learning_sessions s ON s.id::text=a.checkpoint_json->'spanLesson'->>'sessionId'
      AND s.activity_id=a.id AND s.course_id=a.course_id AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${courseId}
      AND (a.create_intent->>'protocol'='span-lesson-v1' OR a.goal_json ? 'courseRoute')
      AND ${activityId ? tx`a.id=${activityId}` : tx`a.status IN ('active','paused')`}
    ORDER BY a.updated_at DESC,a.id DESC LIMIT 1`;
  if (!activity) return null;
  const aid = String(activity.id), sessionId = text(activity.session_id), goal = object(activity.goal_json);
  const route = object(goal.courseRoute), checkpoint = object(object(activity.checkpoint_json).spanLesson);
  const [intentEvent] = sessionId ? await tx`SELECT id,version,resulting_intent FROM opening_study_intent_events WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND session_id=${sessionId} ORDER BY version DESC LIMIT 1` : [];
  const intent = object(goal.sessionIntent ?? checkpoint.intent ?? intentEvent?.resulting_intent), create = object(activity.create_intent);
  const [attempt] = sessionId ? await tx`SELECT id,item_version_id FROM opening_learning_attempts
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} AND activity_id=${aid} AND session_id=${sessionId}
    ORDER BY started_at DESC,id DESC LIMIT 1` : [];
  const help = sessionId ? await tx`SELECT level FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND course_id=${courseId} AND activity_id=${aid} AND session_id=${sessionId} AND delivered=true AND released_at IS NOT NULL
    AND support_domain<>'language'` : [];
  const [decisionRow] = await tx`SELECT d.id FROM opening_learning_decisions d WHERE d.workspace_id=${scope.workspaceId} AND d.owner_user_id=${scope.ownerUserId}
    AND d.layer='activity' AND d.target_id=${aid}
    AND (${sessionId}::uuid IS NULL OR d.parent_decision_id IS NULL OR EXISTS (SELECT 1 FROM opening_learning_decisions p
      WHERE p.id=d.parent_decision_id AND p.workspace_id=d.workspace_id AND p.owner_user_id=d.owner_user_id AND p.layer='session' AND p.target_id=${sessionId}))
    ORDER BY d.created_at DESC,d.id DESC LIMIT 1`;
  const decision = decisionRow ? await readOpeningLearningDecision(tx, scope, String(decisionRow.id)) : null;
  const reasons: string[] = [];
  const authorization = await readSpanTutorAuthorization(tx, scope, courseId);
  if (activity.archived_at) reasons.push("course_unavailable");
  if (goal.tutorNextAction && !authorization.authorized) reasons.push(`permission:${authorization.reason}`);
  let status = String(activity.status) as LearningAgenda["status"];
  const retestId = text(checkpoint.retestId ?? route.retestId);
  if (retestId) {
    const [retest] = await tx`SELECT r.*,t.status AS task_status,t.not_before FROM opening_retest_activities r
      LEFT JOIN opening_tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id AND t.owner_user_id=r.owner_user_id
      WHERE r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId} AND r.course_id=${courseId}
        AND (r.id=${retestId} OR r.candidate_id=${retestId} OR r.candidate_reference_id=${retestId})`;
    if (!retest || ["cancelled","expired","invalidated"].includes(String(retest.status)) || retest.task_status === "skipped") { status = "cancelled"; reasons.push("retest_cancelled_or_unavailable"); }
    else if ([retest.snoozed_until,retest.not_before_at,retest.not_before,retest.scheduled_start_at ?? retest.recommended_at].some(value => value && new Date(value).getTime() > Date.now())) { status = "deferred"; reasons.push("retest_deferred"); }
    else if (retest.status === "completed" || retest.task_status === "done") status = "completed";
  }
  const sourceIds = [...new Set([...(activity.source_ids as string[]), ...Object.keys(decision?.policyVersion === "span-teaching-v2" ? {} : decision?.sourceVersions ?? {})])];
  const sources = sourceIds.length ? await tx`SELECT s.id,s.version FROM opening_sources s JOIN course_asset_memberships m
    ON m.asset_id=s.id AND m.workspace_id=s.workspace_id AND m.course_id=${courseId} AND m.asset_type='source'
    WHERE s.workspace_id=${scope.workspaceId} AND s.id=ANY(${sourceIds}::uuid[]) AND s.upload_state='uploaded'
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)` : [];
  if (sources.length !== sourceIds.length) reasons.push("source_unavailable");
  const state = activity.archived_at ? null : await readOpeningLearnerState(tx, scope, { courseId });
  if (Object.keys(route).length) {
    try { await assertOpeningCourseRouteCurrent(tx, scope, aid); }
    catch (error) { if ((error as { code?: string }).code !== "CONFLICT") throw error; reasons.push("goal_requirement_or_source_changed"); }
  }
  if (decision && state) {
    const captured = parseVersion(decision);
    let goalVersion = decision.goalVersion, intentVersion = decision.intentVersion, policyVersion = decision.policyVersion;
    if (decision.policyVersion.includes("/span-tutor-execution-")) {
      goalVersion = JSON.stringify({ courseId, requirementKey: SPAN_REQUIREMENT_KEY, grantRevision: authorization.grant?.revision ?? null });
      policyVersion = SPAN_TUTOR_EXECUTION_POLICY_VERSION;
      if (!isDeepStrictEqual(captured.intent, intent)) intentVersion = "persisted_intent_changed";
    } else if (decision.policyVersion === "span-teaching-v2") {
      goalVersion = "span-unit-v1";
      intentVersion = intentEvent && isDeepStrictEqual(intentEvent.resulting_intent, intent)
        ? `${intentEvent.id}:v${intentEvent.version}` : "persisted_intent_changed";
    } else if (decision.policyVersion === "course-route-1") {
      const currentGoal = await readLearningGoal(tx, scope, String(route.goalId));
      goalVersion = `goal:${route.goalId}:v${currentGoal?.revision ?? "unavailable"}`;
    } else { reasons.push("policy_version_not_revalidated"); }
    // span-teaching-v2 captured workspace-wide inputs; keep old receipts in that scope.
    const validationState = decision.policyVersion === "span-teaching-v2" ? await readOpeningLearnerState(tx, scope) : state;
    const sourceVersions = structuredClone(validationState.sourceVersions);
    for (const id of Object.keys(decision.sourceVersions)) {
      if (decision.policyVersion === "span-teaching-v2") continue;
      const current = sources.find(row => row.id === id);
      sourceVersions[id] = current ? [...new Set([...(sourceVersions[id] ?? []), Number(current.version)])].sort((a,b) => a-b) : [];
    }
    reasons.push(...learningDecisionInvalidation(decision, { stateVersion: validationState.stateVersion, sourceVersions, goalVersion, intentVersion, policyVersion }));
  }
  const invalidationReasons = [...new Set(reasons)];
  const observations: NextLearningStepInput["observations"] = (state?.features ?? []).filter(row => row.requirementKey === (route.requirementKey ?? SPAN_REQUIREMENT_KEY))
    .reverse().map(row => ({ id: row.observationId, skillLabel: row.skillLabel, requirementKey: row.requirementKey, attemptedAt: row.attemptedAt,
      assistance: row.views.includes("help") ? "hinted" : "independent", ...row.eligibility, problemId: null }));
  const suggestion = invalidationReasons.length ? nextLearningStep({ observations,
    status: !observations.length ? "unobserved" : observations[0]!.verifiedCorrect === "yes" && observations[0]!.independentAttempt === "yes" ? "observed_independent" : "needs_check",
    wantsFullExplanation: intent.explanationStyle === "full", ...(intent.learningPhase ? { learningPhase: intent.learningPhase as NextLearningStepInput["learningPhase"], phaseSource: "explicit" as const } : {}) }) : null;
  const captured = decision ? parseVersion(decision) : {};
  return assembleLearningAgenda({ courseId, goalId: text(route.goalId ?? object(goal.learningBudget).goalId), activityId: aid, sessionId,
    itemVersionId: text(attempt?.item_version_id), status, mode: agendaMode(object(captured.ruleDecision).activityKind ?? route.action),
    intent: Object.keys(intent).length ? intent as LearningAgenda["intent"] : null, moveId: text(checkpoint.moveId),
    userOverride: text(intent.explanationStyle), help: { delivered: help.length > 0, level: help.some(row => row.level === "revealed") ? "revealed" : help.length ? "hinted" : "none" },
    requirement: text(route.requirementKey ?? activity.skill_label), selectedAction: decision?.selectedAction ?? null,
    returnTo: text(route.returnTo ?? create.returnTo), originActivityId: text(route.originActivityId ?? create.originActivityId), pendingRetestId: retestId,
    budget: goal.learningBudget || goal.tutorBudget ? object(goal.learningBudget ?? goal.tutorBudget) : null, decisionId: decision?.id ?? null, parentDecisionId: decision?.parentDecisionId ?? null,
    decisionCurrent: decision ? invalidationReasons.length === 0 : null, invalidationReasons, suggestion,
    resumable: ["active","paused"].includes(status) && invalidationReasons.every(reason => ["state_changed", "intent_changed", "policy_changed"].includes(reason)),
    dataAsOf: state?.dataAsOf ?? new Date().toISOString() });
}
function agendaMode(value: unknown): LearningAgenda["mode"] {
  return ["diagnose","targeted_explain","full_explain","reduced_help_practice","transfer_check"].includes(String(value)) ? value as LearningAgenda["mode"] : "unknown";
}
function parseVersion(decision: LearningDecision): Record<string, unknown> {
  // Receipts are durable JSON captured by the canonical execution owner.
  if (!decision.intentVersion.startsWith("{")) return {};
  return object(JSON.parse(decision.intentVersion));
}
export function createOpeningLearningAgendaRepository(sql: Sql) {
  return { get: (scope: Scope, courseId: string, activityId?: string | null) => sql.begin("isolation level repeatable read read only", tx => readOpeningLearningAgenda(tx, scope, courseId, activityId)) as Promise<LearningAgenda | null> };
}
