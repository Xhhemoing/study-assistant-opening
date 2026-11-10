import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { spanPrerequisiteRefusalReasonSchema, spanPrerequisiteRepairPlanSchema, type CourseRequirement, type Scope, type SpanCourseBinding,
  type SpanPrerequisiteRepairPlan, type SpanPrerequisiteRefusalReason, type SpanRepairRequirementIdentity } from "@aistudy/contracts";
import { chooseSpanRepairTeaching, diagnoseSpanRepair, qualifySpanPrerequisiteRepair, type SpanPrerequisiteQualificationInput } from "@aistudy/domain";
import { getSpanTeachingProblem, spanProblemContentKey } from "@aistudy/domain/span-heldout-catalog";
import type { Sql, TransactionSql } from "postgres";
import { readCourseRequirements, readCourseRouteMaterials, readCourseRouteSourceChunks } from "./opening-course-route-read";
import { readOpeningSpanCourseAttempt, readOpeningSpanCourseBinding, readOpeningSpanCourseScope, SPAN_PREREQUISITE_POLICY } from "./opening-span-course-binding";
import { mapLearningAttempt } from "./opening-learning-attempts";
import { learningError, mapLearningObservation, admitLearningSources, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { readOpeningSpanExposureHistory, parseOpeningSpanExercise } from "./opening-span-attempt";
import { readOpeningCourseSpanDecisionInTx } from "./opening-span-tutor-context";
import { lockSpanTutorAuthorization, readSpanTutorAuthorization } from "./opening-span-tutor-grant";
import { reserveSpanTutorActivityBudget } from "./opening-span-tutor-budget";
import { recordOpeningLearningDecision } from "./opening-learning-decisions";
import { readOpeningLearnerState } from "./opening-learner-state-read";
import { DEFAULT_STUDY_SESSION_INTENT, SPAN_SKILL_LABEL } from "@aistudy/domain";

type Db = Sql | TransactionSql;
export function prerequisiteConflict(reasonCode: SpanPrerequisiteRefusalReason) {
  return Object.assign(learningError("CONFLICT", "先修补讲的原始依据、关系或内容不可继续执行；历史与原位置保留，未回退普通练习。"), { reasonCode });
}
export const prerequisiteIdentity = (r: CourseRequirement): SpanRepairRequirementIdentity =>
  ({ id: r.id, revision: r.revision, stableSkillId: r.stableSkillId, requirementKey: r.requirementKey });

/** Latest original submission time wins, not regrade time or a search for an older incorrect head. */
async function qualify(db: Db, scope: Scope, courseId: string, target: CourseRequirement, prerequisite: CourseRequirement, observationId?: string) {
  const requirements = await readCourseRequirements(db, scope, courseId);
  const materials = await readCourseRouteMaterials(db, scope, courseId);
  const chunks = await readCourseRouteSourceChunks(db, scope, courseId);
  const rows = await db`SELECT a.*,v.evaluation_spec,v.stem_snapshot AS item_stem_snapshot,o.id AS head_id
    FROM opening_learning_attempts a
    JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
    JOIN opening_learning_observations root ON root.id=a.observation_id AND root.attempt_id=a.id
      AND root.workspace_id=a.workspace_id AND root.owner_user_id=a.owner_user_id
    JOIN opening_learning_observations o ON o.id=COALESCE(root.effective_head_id,root.id)
      AND o.workspace_id=root.workspace_id AND o.owner_user_id=root.owner_user_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${courseId}
      AND a.create_intent->'spanCourseBinding'->'requirement'->>'id'=${prerequisite.id}
      AND (${observationId ?? null}::uuid IS NULL OR o.id=${observationId ?? null}::uuid)
    ORDER BY a.submitted_at DESC NULLS LAST,a.started_at DESC,a.id DESC LIMIT 1`;
  let evidence: SpanPrerequisiteQualificationInput["evidence"] = null;
  const row = rows[0];
  if (row) {
    let authority;
    try { authority = await readOpeningSpanCourseAttempt(db, scope, row); }
    catch (error) {
      if (!spanPrerequisiteRefusalReasonSchema.safeParse((error as {reasonCode?:unknown}).reasonCode).success) throw error;
      // Initial admission treats drift as missing trusted P evidence; saved plans compare the original qualification below.
    }
    if (authority && !authority.binding.returnTarget) {
      const [head] = await db`SELECT * FROM opening_learning_observations WHERE id=${String(row.head_id)}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      if (head) {
        const observation = mapLearningObservation(head);
        const [root] = await db`SELECT id,effective_head_id FROM opening_learning_observations
          WHERE id=${observation.rootObservationId ?? observation.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        const contexts = await readOpeningLearningEvidenceContexts(db, scope, [observation]);
        const context = contexts[observation.id]?.context;
        if (root && context) evidence = { observation, root: { id: String(root.id), effectiveHeadId: root.effective_head_id as string | null },
          attempt: { ...mapLearningAttempt(row), courseRequirement: authority.binding.requirement }, evaluationSpec: row.evaluation_spec, context };
      }
    }
  }
  const qualification = qualifySpanPrerequisiteRepair({ courseId, targetBinding: prerequisiteIdentity(target),
    prerequisiteBinding: prerequisiteIdentity(prerequisite), requirements,
    sources: new Map(materials.filter(m => m.available).map(m => [m.sourceId, m.sourceVersion])), chunks, evidence });
  return { qualification, row, evidence };
}

/** Only called under the original course action's history transaction, never by GET. */
export async function createOpeningSpanPrerequisiteInTx(tx: TransactionSql, scope: Scope, input: {
  courseId: string; target: CourseRequirement; goalId: string; goalRevision: number; minutes: number; key: string;
}) {
  const requirements = await readCourseRequirements(tx, scope, input.courseId);
  const direct = requirements.filter(r => input.target.prerequisiteIds.includes(r.id));
  const qualified: Array<{ result: Awaited<ReturnType<typeof qualify>>; prerequisite: CourseRequirement }> = [];
  for (const prerequisite of direct) {
    const result = await qualify(tx, scope, input.courseId, input.target, prerequisite);
    if (result.qualification.status === "verified_weak") qualified.push({ result, prerequisite });
  }
  if (qualified.length !== 1) return { kind: "unavailable" as const, reason: qualified.length > 1 ? "needs_clarification" : "unknown" };
  const { result, prerequisite } = qualified[0]!;
  const q = result.qualification;
  if (q.status !== "verified_weak" || !result.row || !result.evidence) return { kind: "unavailable" as const, reason: "unknown" };
  const problem = parseOpeningSpanExercise(result.row.evaluation_spec);
  const evaluation = result.evidence.observation.serverEvaluation;
  const diagnosis = problem && evaluation?.evaluatorVersion === "span-exact-v1" && evaluation.skills
    ? diagnoseSpanRepair(problem, result.evidence.observation.answer, { skills: evaluation.skills, outcome: "incorrect" }) : null;
  if (!problem || !diagnosis || diagnosis.status !== "ready") return { kind: "unavailable" as const, reason: "needs_clarification" };
  const root = await readOpeningSpanCourseBinding(tx, scope, String(result.row.activity_id));
  if (!root || root.binding.goalId !== input.goalId || root.binding.goalRevision !== input.goalRevision)
    return { kind: "unavailable" as const, reason: "unknown" };
  const binding: SpanCourseBinding = { ...root.binding, returnTarget: prerequisiteIdentity(input.target), relationSource: "confirmed_course_requirement" };
  const current = await readOpeningSpanCourseScope(tx, scope, binding);
  const sourceIds = [...new Set(prerequisite.sourceRefs.map(ref => ref.sourceId))].sort();
  const allSources = [...new Set([...sourceIds, ...input.target.sourceRefs.map(ref => ref.sourceId)])].sort();
  if (allSources.length > 32) return { kind: "unavailable" as const, reason: "needs_clarification" };
  const authorization = await readSpanTutorAuthorization(tx, scope, input.courseId);
  if (!authorization.grant) return { kind: "unavailable" as const, reason: "authorization_required" };
  const locked = await lockSpanTutorAuthorization(tx, scope, input.courseId, authorization.grant.revision);
  if (!locked.authorized) return { kind: "unavailable" as const, reason: "authorization_required" };
  await admitLearningSources(tx, scope, allSources);
  const memberships = await tx`SELECT asset_id FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId}
    AND course_id=${input.courseId} AND asset_type='source' AND asset_id=ANY(${allSources}::uuid[])
    AND (purpose IS NULL OR purpose='teaching') ORDER BY asset_id FOR SHARE`;
  if (memberships.length !== allSources.length) throw prerequisiteConflict("SPAN_PREREQUISITE_SOURCE_UNAVAILABLE");
  await readOpeningSpanCourseScope(tx, scope, binding);
  const intent = { ...DEFAULT_STUDY_SESSION_INTENT, purpose: "self_study" as const, timeBudgetMinutes: input.minutes };
  const versions = Object.fromEntries(prerequisite.sourceRefs.map(ref => [ref.sourceId, ref.sourceVersion]));
  const rule = await readOpeningCourseSpanDecisionInTx(tx, scope, root.binding, sourceIds, versions, intent);
  if (rule.decision.activityKind !== "targeted_explain" || rule.decision.focusObservationId !== q.basis.observationId
    || rule.decision.reasonCode === "remediation_limit") return { kind: "unavailable" as const, reason: "needs_clarification" };
  const history = await readOpeningSpanExposureHistory(tx, scope);
  const pair = chooseSpanRepairTeaching(problem, history, current.allowedExerciseKeys.flatMap(id => { const p = getSpanTeachingProblem(id); return p ? [p] : []; }));
  if (!pair) return { kind: "unavailable" as const, reason: "needs_clarification" };
  const plan = spanPrerequisiteRepairPlanSchema.parse({ version: 1, contentVersion: 1, status: "ready", qualification: q,
    courseBinding: binding, targetSkill: diagnosis.targetSkill, teachingExample: { problemId: pair.teachingExample.id, version: pair.teachingExample.version },
    practiceVariant: { problemId: pair.practiceVariant.id, version: pair.practiceVariant.version }, returnToRequirementId: input.target.id });
  const activityId = randomUUID(), sessionId = randomUUID();
  const courseRoute = { goalId: input.goalId, goalRevision: input.goalRevision, requirementId: prerequisite.id,
    requirementRevision: prerequisite.revision, stableSkillId: prerequisite.stableSkillId, requirementKey: prerequisite.requirementKey,
    action: "prerequisite", returnTo: input.target.id };
  await tx`INSERT INTO opening_teaching_activities
    (id,workspace_id,owner_user_id,course_id,status,generate_status,intent_kind,intent_summary,source_ids,goal_json,path_version,content_version,checkpoint_json,client_key,create_intent)
    VALUES (${activityId},${scope.workspaceId},${scope.ownerUserId},${input.courseId},'active','ready','goal',${`先补 ${prerequisite.title}；本块后明确返回原要求`},
      ${sourceIds},${tx.json({ sessionIntent: intent, spanCourseBinding: binding, spanPrerequisiteRepair: plan, courseRoute,
        tutorNextAction: { decision: rule.decision, observationIds: [q.basis.observationId], sourceRefs: q.basis.sourceRefs, grantRevision: locked.grant!.revision } })},
      1,0,${tx.json({ spanLesson: { sessionId, intent, moveId: "self-example", retestId: null } })},${input.key},
      ${tx.json({ protocol: "span-lesson-v1", kind: "course_route", prerequisiteRequest: input })})`;
  await tx`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label,source_ids)
    VALUES (${sessionId},${scope.workspaceId},${scope.ownerUserId},${input.courseId},${activityId},${SPAN_SKILL_LABEL},${sourceIds})`;
  await reserveSpanTutorActivityBudget(tx, scope, { courseId: input.courseId, activityId, minutes: input.minutes, expectedGrantRevision: locked.grant!.revision });
  await nextWorkspaceLearningHistoryRevision(tx, scope);
  const state = await readOpeningLearnerState(tx, scope, { courseId: input.courseId });
  const sourceVersions = Object.fromEntries([...prerequisite.sourceRefs, ...input.target.sourceRefs].map(ref => [ref.sourceId, [ref.sourceVersion]]));
  await recordOpeningLearningDecision(tx, scope, { layer: "activity", targetId: activityId, stateVersion: state.stateVersion, dataAsOf: state.dataAsOf,
    goalVersion: `goal:${input.goalId}:v${input.goalRevision}`, intentVersion: JSON.stringify({ courseBinding: binding, spanPrerequisiteRepair: plan, courseRoute, sessionId, sourceIds, ruleDecision: rule.decision }),
    policyVersion: SPAN_PREREQUISITE_POLICY, sourceVersions, invalidationConditions: ["state_changed", "goal_changed", "source_changed", "policy_changed"],
    selectedAction: "create:prerequisite", reasonCodes: ["direct_verified_weak"], evidenceRefs: [q.basis.observationId],
    candidates: [{ action: "create:prerequisite", eligible: true, reasonCodes: ["direct_verified_weak"], evidenceRefs: [q.basis.observationId] }] },
  `span-prerequisite-execution:${activityId}`);
  await readOpeningSpanPrerequisiteRepair(tx, scope, activityId);
  return { kind: "created" as const, activityId, requirementId: prerequisite.id };
}

/** Validate only the saved basis and receipt. Never reselect a head or teaching pair. */
export async function readOpeningSpanPrerequisiteRepair(db: Db, scope: Scope, activityId: string): Promise<SpanPrerequisiteRepairPlan | null> {
  const [activity] = await db`SELECT goal_json,checkpoint_json FROM opening_teaching_activities WHERE id=${activityId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!activity) throw learningError("NOT_FOUND", "学习活动不存在。");
  const goal = (activity.goal_json ?? {}) as { spanPrerequisiteRepair?: unknown; spanRepair?: unknown; spanCourseBinding?: { returnTarget?: unknown } };
  if (!Object.hasOwn(goal, "spanPrerequisiteRepair")) {
    if (goal.spanCourseBinding?.returnTarget) throw prerequisiteConflict("SPAN_PREREQUISITE_PLAN_UNSUPPORTED");
    return null;
  }
  const parsed = spanPrerequisiteRepairPlanSchema.safeParse(goal.spanPrerequisiteRepair);
  if (!parsed.success || goal.spanRepair !== undefined) throw prerequisiteConflict("SPAN_PREREQUISITE_PLAN_UNSUPPORTED");
  const plan = parsed.data, q = plan.qualification;
  const lesson = (activity.checkpoint_json as { spanLesson?: { intent?: { purpose?: string }; retestId?: string | null } })?.spanLesson;
  if (q.status !== "verified_weak" || lesson?.intent?.purpose !== "self_study" || lesson.retestId)
    throw prerequisiteConflict("SPAN_PREREQUISITE_PLAN_UNSUPPORTED");
  const current = await readOpeningSpanCourseBinding(db, scope, activityId);
  if (!current || !isDeepStrictEqual(current.binding, plan.courseBinding)) throw prerequisiteConflict("SPAN_PREREQUISITE_RECEIPT_MISMATCH");
  const requirements = await readCourseRequirements(db, scope, q.courseId);
  const target = requirements.find(r => r.id === q.targetRequirement.id), prerequisite = requirements.find(r => r.id === q.prerequisiteRequirement.id);
  if (!target || !prerequisite) throw prerequisiteConflict("SPAN_PREREQUISITE_RELATION_CHANGED");
  const original = await qualify(db, scope, q.courseId, target, prerequisite, q.basis.observationId);
  if (!isDeepStrictEqual(original.qualification, q)) throw prerequisiteConflict("SPAN_PREREQUISITE_EVIDENCE_CHANGED");
  const problem = original.row && parseOpeningSpanExercise(original.row.evaluation_spec);
  const evaluation = original.evidence?.observation.serverEvaluation;
  const diagnosis = problem && original.evidence && evaluation?.evaluatorVersion === "span-exact-v1" && evaluation.skills
    ? diagnoseSpanRepair(problem, original.evidence.observation.answer, { skills: evaluation.skills, outcome: "incorrect" }) : null;
  const example = getSpanTeachingProblem(plan.teachingExample.problemId, plan.teachingExample.version);
  const variant = getSpanTeachingProblem(plan.practiceVariant.problemId, plan.practiceVariant.version);
  if (!problem || diagnosis?.status !== "ready" || diagnosis.targetSkill !== plan.targetSkill || !example || !variant
    || [example, variant].some(p => !current.allowedExerciseKeys.includes(p.id) || p.familyId !== problem.familyId || p.target.length !== problem.target.length)
    || spanProblemContentKey(example) === spanProblemContentKey(variant)
    || [example, variant].some(p => spanProblemContentKey(p) === spanProblemContentKey(problem))) throw prerequisiteConflict("SPAN_PREREQUISITE_CONTENT_UNSUPPORTED");
  return plan;
}
