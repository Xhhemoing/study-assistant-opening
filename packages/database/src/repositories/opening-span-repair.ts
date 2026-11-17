import { isDeepStrictEqual } from "node:util";
import { spanRepairPlanSchema, type Scope, type SpanProblem, type SpanRepairEvidence, type SpanRepairPlan, type SpanLessonSaveInput, type SpanLessonSnapshot } from "@aistudy/contracts";
import { chooseSpanRepairTeaching, diagnoseSpanRepair, evaluateEvidenceEligibility, SPAN_REQUIREMENT_KEY, spanProblemStem, verifySpanAnswer } from "@aistudy/domain";
import { getSpanTeachingProblem, spanProblemContentKey } from "@aistudy/domain/span-heldout-catalog";
import type { Sql, TransactionSql } from "postgres";
import { listGeneratedSpanItems } from "../../../domain/src/opening/span-generated-items";
import { contextSourceRefsIncluded, type ContextSourceRef } from "./opening-context-provenance";
import { learningError, mapLearningObservation } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { parseOpeningSpanExercise, readOpeningSpanExposureHistory } from "./opening-span-attempt";
import { generateOpeningStudyExposure, releaseOpeningStudyExposure } from "./opening-study-exposure";

import { readOpeningSpanPrerequisiteRepair } from "./opening-span-prerequisite-runtime";
import type { SpanPrerequisiteRepairPlan } from "@aistudy/contracts";
/** Narrow shared stage reader; legacy A parsing and receipt interpretation remain separate. */
export async function readOpeningSpanStagePlan(db: Sql | TransactionSql, scope: Scope, activityId: string) {
  return await readOpeningSpanPrerequisiteRepair(db, scope, activityId) ?? await readOpeningSpanRepair(db, scope, activityId);
}
const planIsB = (plan: SpanRepairPlan | SpanPrerequisiteRepairPlan): plan is SpanPrerequisiteRepairPlan => "courseBinding" in plan;
const planKey = (plan: SpanRepairPlan | SpanPrerequisiteRepairPlan, activityId: string, stage: "example" | "variant" | "confirmation") =>
  planIsB(plan) ? spanPrerequisiteAttemptKey(activityId, stage) : spanRepairAttemptKey(activityId, stage);
export const spanPrerequisiteAttemptKey = (activityId: string, stage: "example" | "variant" | "confirmation") => `span-prerequisite:${activityId}:v1:${stage}`;
async function stageKey(db: Sql | TransactionSql, scope: Scope, activityId: string, stage: "example" | "variant" | "confirmation") {
  const plan = await readOpeningSpanStagePlan(db, scope, activityId);
  return plan ? planKey(plan, activityId, stage) : spanRepairAttemptKey(activityId, stage);
}
const prerequisite = { status: "unknown" as const, reasonCode: "prerequisite_binding_missing" as const };
const conflict = (message: string) => Object.assign(learningError("CONFLICT", message), { reasonCode: "SPAN_REPAIR_CHANGED" });
function canonicalSpecMatches(raw: unknown, problem: SpanProblem) {
  return isDeepStrictEqual(raw, { kind: "span", specVersion: "span-v1", problemId: problem.id, version: Number(problem.version),
    familyId: problem.familyId, requirementKey: SPAN_REQUIREMENT_KEY, knowledgeComponents: problem.knowledgeComponents, transfer: problem.transfer ?? null });
}
export function parseOpeningSpanRepair(goal: unknown): SpanRepairPlan | null {
  const raw = (goal as { spanRepair?: unknown } | null)?.spanRepair;
  if (raw === undefined) return null; // Old activities are not retrofitted.
  const parsed = spanRepairPlanSchema.safeParse(raw);
  if (!parsed.success) throw conflict("本题步骤计划版本或内容不可核实，请保留原进度并核对；未回退通用讲解。");
  return parsed.data;
}

type Db = Sql | TransactionSql;
/** Current head/root/attempt/frozen canonical identity and exact evaluation are one qualification boundary. */
async function readBasis(db: Db, scope: Scope, courseId: string, observationId: string, refs: readonly ContextSourceRef[]) {
  const [row] = await db`SELECT o.*,COALESCE(o.root_observation_id,o.id) AS repair_root_id,
      a.id AS attempt_identity,a.session_id AS attempt_session,a.course_id AS attempt_course,a.problem_id AS attempt_problem,
      a.item_version_id AS attempt_item,a.observation_id AS attempt_observation,a.source_versions AS attempt_sources,
      v.evaluation_spec,v.stem_snapshot,v.source_id AS item_source
    FROM opening_learning_observations o
    JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
      AND COALESCE(root.effective_head_id,root.id)=o.id
    JOIN opening_learning_attempts a ON a.id=o.attempt_id AND a.workspace_id=o.workspace_id AND a.owner_user_id=o.owner_user_id
    JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.problem_id=a.problem_id
      AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
    WHERE o.id=${observationId} AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
      AND o.course_id=${courseId} AND COALESCE(o.revision_kind,'original')<>'retract'`;
  if (!row) return null;
  const observation = mapLearningObservation(row), evaluation = observation.serverEvaluation;
  const problem = parseOpeningSpanExercise(row.evaluation_spec);
  if (!problem || !canonicalSpecMatches(row.evaluation_spec, problem) || row.stem_snapshot !== spanProblemStem(problem) || !observation.sourceIds.includes(String(row.item_source))
    || observation.requirementKey !== SPAN_REQUIREMENT_KEY || !observation.sourceVersions
    || evaluation?.evaluatorVersion !== "span-exact-v1" || evaluation.specVersion !== "span-v1" || !evaluation.skills
    || evaluation.observationId !== observation.id || evaluation.attemptId !== row.attempt_identity
    || evaluation.problemId !== row.attempt_problem || evaluation.itemVersionId !== row.attempt_item
    || evaluation.requirementKey !== SPAN_REQUIREMENT_KEY || row.attempt_course !== courseId || row.attempt_session !== observation.sessionId
    || row.attempt_problem !== observation.problemId || row.attempt_item !== observation.itemVersionId
    || row.attempt_observation !== row.repair_root_id && row.attempt_observation !== observation.id
    || !isDeepStrictEqual(row.attempt_sources, observation.sourceVersions)
    || observation.sourceIds.some(id => !refs.some(ref => ref.sourceId === id && ref.sourceVersion === observation.sourceVersions?.[id]))) return null;
  const [available] = await db`SELECT 1 AS ok WHERE ${contextSourceRefsIncluded(db, scope.workspaceId, db`${db.json([...refs])}`)}`;
  if (!available) return null;
  const contexts = await readOpeningLearningEvidenceContexts(db, scope, [observation]);
  const context = contexts[observation.id];
  if (!context || evaluateEvidenceEligibility(context.observation, context.context).usableForCurrentVersion !== "yes") return null;
  const verified = verifySpanAnswer(problem, observation.answer);
  if (evaluation.decision !== "incorrect" || evaluation.outcome !== "incorrect" || verified.outcome !== "incorrect"
    || evaluation.coreEvidenceComplete !== verified.coreEvidenceComplete || evaluation.membershipOutcome !== verified.membershipOutcome) return null;
  const diagnosis = diagnoseSpanRepair(problem, observation.answer, { skills: evaluation.skills, outcome: "incorrect" });
  const basis: SpanRepairEvidence = { observationId: observation.id, rootObservationId: String(row.repair_root_id),
    attemptId: String(row.attempt_identity), problemId: String(row.attempt_problem), itemVersionId: String(row.attempt_item),
    sourceRefs: refs.map(ref => ({ ...ref })), evaluatorVersion: "span-exact-v1", specVersion: "span-v1" };
  return { problem, basis, diagnosis };
}

/** Select two different teaching content identities in the original family and dimension. Never selects confirmation here. */
export function chooseOpeningSpanRepairTeaching(problem: SpanProblem, history: { contentKeys: Set<string>; unknownHistory: boolean }) {
  return chooseSpanRepairTeaching(problem, history, listGeneratedSpanItems("teaching"));
}

/** Caller holds the existing authorization/history/budget transaction. No GET-time selection or backfill. */
export async function createOpeningSpanRepairPlanInTx(tx: TransactionSql, scope: Scope, input: {
  courseId: string; focusObservationId: string | null; sourceRefs: readonly ContextSourceRef[];
}): Promise<SpanRepairPlan> {
  const clarification = (reasonCode: Extract<SpanRepairPlan, { status: "needs_clarification" }>["reasonCode"]): SpanRepairPlan =>
    ({ version: 1, contentVersion: 1, status: "needs_clarification", reasonCode, prerequisite });
  if (!input.focusObservationId) return clarification("evidence_unavailable");
  const qualified = await readBasis(tx, scope, input.courseId, input.focusObservationId, input.sourceRefs);
  if (!qualified) return clarification("evidence_unavailable");
  if (qualified.diagnosis.status !== "ready") return clarification(qualified.diagnosis.reasonCode);
  const history = await readOpeningSpanExposureHistory(tx, scope);
  if (history.unknownHistory) return clarification("unknown_history");
  const pair = chooseOpeningSpanRepairTeaching(qualified.problem, history);
  if (!pair) return clarification("teaching_unavailable");
  const identity = (problem: SpanProblem) => ({ problemId: problem.id, version: problem.version });
  return spanRepairPlanSchema.parse({ version: 1, contentVersion: 1, status: "ready", basis: qualified.basis,
    targetSkill: qualified.diagnosis.targetSkill, diagnosticBasis: "first_verified_dependency_step", prerequisite,
    teachingExample: identity(pair.teachingExample), practiceVariant: identity(pair.practiceVariant), returnMoveId: "self_study-reserved" });
}

/** Only validates the saved plan against its original execution receipt. Never chooses new content or writes. */
export async function readOpeningSpanRepair(db: Db, scope: Scope, activityId: string): Promise<SpanRepairPlan | null> {
  const [activity] = await db`SELECT a.course_id,a.goal_json,a.checkpoint_json FROM opening_teaching_activities a
    JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
    WHERE a.id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  if (!activity) throw learningError("NOT_FOUND", "学习活动不存在。");
  const plan = parseOpeningSpanRepair(activity.goal_json);
  const receipts = await db`SELECT receipt FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND target_id=${activityId} AND layer='activity'
    AND receipt->>'policyVersion'='next-learning-step-6/span-tutor-execution-2'`;
  if (!plan) {
    if (receipts.some(row => {
      try { return Object.hasOwn(JSON.parse(String((row.receipt as { intentVersion?: string }).intentVersion)), "spanRepair"); }
      catch { return false; }
    })) throw conflict("执行回执中的本题步骤计划缺失，未回退通用讲解。");
    return null;
  }
  const lesson = (activity.checkpoint_json as { spanLesson?: { intent?: { purpose?: string }; retestId?: string | null } })?.spanLesson;
  if (lesson?.intent?.purpose !== "self_study" || lesson.retestId) throw conflict("本题步骤计划与学习目的不一致。");
  const captured = receipts.some(row => {
    const receipt = row.receipt as { intentVersion?: unknown };
    if (typeof receipt.intentVersion !== "string") return false;
    let context: { spanRepair?: unknown; courseId?: string; ruleDecision?: { activityKind?: string; focusObservationId?: string } };
    try { context = JSON.parse(receipt.intentVersion); } catch { return false; }
    return context.courseId === activity.course_id && context.ruleDecision?.activityKind === "targeted_explain"
      && (plan.status !== "ready" || context.ruleDecision.focusObservationId === plan.basis.observationId)
      && isDeepStrictEqual(context.spanRepair, plan);
  });
  if (!captured) throw conflict("本题步骤计划缺少匹配的执行回执。");
  if (plan.status === "ready") {
    const qualified = await readBasis(db, scope, String(activity.course_id), plan.basis.observationId, plan.basis.sourceRefs);
    const example = getSpanTeachingProblem(plan.teachingExample.problemId, plan.teachingExample.version);
    const variant = getSpanTeachingProblem(plan.practiceVariant.problemId, plan.practiceVariant.version);
    if (!qualified || !isDeepStrictEqual(qualified.basis, plan.basis) || qualified.diagnosis.status !== "ready"
      || qualified.diagnosis.targetSkill !== plan.targetSkill || !example || !variant
      || example.familyId !== qualified.problem.familyId || variant.familyId !== qualified.problem.familyId
      || example.target.length !== qualified.problem.target.length || variant.target.length !== qualified.problem.target.length
      || spanProblemContentKey(example) === spanProblemContentKey(variant)
      || [example, variant].some(problem => spanProblemContentKey(problem) === spanProblemContentKey(qualified.problem))) {
      throw conflict("原评价、材料或本题步骤内容已变化，请保留原进度并重新核对。");
    }
  }
  return plan;
}

export const spanRepairAttemptKey = (activityId: string, stage: "example" | "variant" | "confirmation") => `span-repair:${activityId}:v1:${stage}`;

export function isOpeningSpanRepairAttemptKey(activityId: string, key: string): boolean {
  return [spanRepairAttemptKey, spanPrerequisiteAttemptKey].some(makeKey => {
    const prefix = `${makeKey(activityId, "variant")}:retry:`;
    return (["example", "variant", "confirmation"] as const).some(stage => key === makeKey(activityId, stage))
      || key.startsWith(prefix) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key.slice(prefix.length));
  });
}
/** Read only already-authorized stage attempts. Random client keys never enter this lineage. */
export async function readOpeningSpanRepairVariant(db: Db, scope: Scope, activityId: string) {
  const key = await stageKey(db, scope, activityId, "variant"), prefix = `${key}:retry:`;
  const [row] = await db`SELECT id,client_key,create_intent,item_version_id FROM opening_learning_attempts
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND activity_id=${activityId}
      AND (client_key=${key} OR left(client_key,${prefix.length})=${prefix}) ORDER BY history_revision DESC,id DESC LIMIT 1`;
  return row ?? null;
}
/** Returns one stable child key; replays do not authorize a grandchild, stale parents cannot fork. */
export async function openingSpanRepairRetryKey(db: Db, scope: Scope, activityId: string, parentId: string) {
  const current = await readOpeningSpanRepairVariant(db, scope, activityId);
  const key = `${await stageKey(db, scope, activityId, "variant")}:retry:${parentId}`;
  if (current?.client_key === key) return key;
  if (current?.id !== parentId) throw conflict("重答的前题已变化或不属于当前步骤，请重新读取。");
  const [head] = await db`SELECT o.server_evaluation,o.revision_kind FROM opening_learning_attempts a
    JOIN opening_learning_observations root ON root.id=a.observation_id AND root.attempt_id=a.id
      AND root.workspace_id=a.workspace_id AND root.owner_user_id=a.owner_user_id
    JOIN opening_learning_observations o ON o.id=COALESCE(root.effective_head_id,root.id)
      AND o.workspace_id=root.workspace_id AND o.owner_user_id=root.owner_user_id
    WHERE a.id=${parentId} AND a.activity_id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  const evaluation = head?.server_evaluation as { decision?: string; coreEvidenceComplete?: boolean } | null;
  if (!head || head.revision_kind === "retract" || evaluation?.decision === "correct" && evaluation.coreEvidenceComplete) {
    throw conflict("请先保留当前题的首答；已完整核验正确的变式不再发放重答。");
  }
  return key;
}

/** Same-item feedback and released help remain real help in the new attempt; never erase the first answer. */
export async function inheritOpeningSpanRepairRetryHelp(tx: TransactionSql, scope: Scope, activityId: string, key: string, attemptId: string) {
  const prefix = `${await stageKey(tx, scope, activityId, "variant")}:retry:`;
  if (!key.startsWith(prefix)) return;
  const parentId = key.slice(prefix.length);
  const [parent] = await tx`SELECT a.item_version_id,a.session_id,o.assistance FROM opening_learning_attempts a
    JOIN opening_learning_observations root ON root.id=a.observation_id AND root.attempt_id=a.id
      AND root.workspace_id=a.workspace_id AND root.owner_user_id=a.owner_user_id
    JOIN opening_learning_observations o ON o.id=COALESCE(root.effective_head_id,root.id)
      AND o.workspace_id=root.workspace_id AND o.owner_user_id=root.owner_user_id
    WHERE a.id=${parentId} AND a.activity_id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  if (!parent) throw conflict("原重答帮助事实不可读取。");
  const [revealed] = await tx`SELECT 1 AS ok FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND item_version_id=${String(parent.item_version_id)} AND delivered=TRUE
    AND kind<>'instruction' AND level='revealed' AND support_domain<>'language'`;
  const level = revealed || parent.assistance === "revealed" ? "revealed" : "hinted";
  const receipt = await generateOpeningStudyExposure(tx, scope, { releaseKey: `${key}:inherited-help`,
    contextAnchor: { activityId, attemptId, itemVersionId: String(parent.item_version_id), purpose: "learning_help" },
    sessionId: String(parent.session_id), origin: "assistant", supportDomain: "math", kind: level === "revealed" ? "solution" : "hint", level });
  await releaseOpeningStudyExposure(tx, scope, receipt.id);
}

/** Owned issued attempt + current exact head, including regrade lineage, never client completion claims. */
export async function stageResult(db: Db, scope: Scope, current: SpanLessonSnapshot, stage: "variant" | "confirmation", requireCorrect: boolean) {
  const variant = stage === "variant" ? await readOpeningSpanRepairVariant(db, scope, current.activityId) : null;
  const key = variant ? String(variant.client_key) : await stageKey(db, scope, current.activityId, stage);
  const [row] = await db`SELECT o.*,a.item_version_id AS issued_item,a.problem_id AS issued_problem,v.evaluation_spec
    FROM opening_learning_attempts a
    JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
    JOIN opening_learning_observations root ON root.id=a.observation_id AND root.attempt_id=a.id
      AND root.workspace_id=a.workspace_id AND root.owner_user_id=a.owner_user_id
    JOIN opening_learning_observations o ON o.id=COALESCE(root.effective_head_id,root.id)
      AND o.workspace_id=root.workspace_id AND o.owner_user_id=root.owner_user_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.activity_id=${current.activityId}
      AND a.session_id=${current.sessionId} AND a.course_id=${current.courseId} AND a.client_key=${key}
      AND COALESCE(o.revision_kind,'original')<>'retract'`;
  if (!row) throw conflict("请先提交当前已发题目；未推进本题步骤。");
  const observation = mapLearningObservation(row), evaluation = observation.serverEvaluation;
  const problem = parseOpeningSpanExercise(row.evaluation_spec);
  const verified = problem ? verifySpanAnswer(problem, observation.answer) : null;
  const contexts = await readOpeningLearningEvidenceContexts(db, scope, [observation]);
  const context = contexts[observation.id];
  if (!problem || !canonicalSpecMatches(row.evaluation_spec, problem) || !verified || verified.outcome === "unknown" || !context
    || evaluateEvidenceEligibility(context.observation, context.context).usableForCurrentVersion !== "yes"
    || evaluation?.evaluatorVersion !== "span-exact-v1" || evaluation.specVersion !== "span-v1"
    || evaluation.observationId !== observation.id || evaluation.attemptId !== observation.attemptId
    || evaluation.problemId !== row.issued_problem || evaluation.itemVersionId !== row.issued_item
    || observation.itemVersionId !== row.issued_item || observation.problemId !== row.issued_problem
    || evaluation.decision !== verified.outcome || !isDeepStrictEqual(evaluation.skills, verified.skills)
    || evaluation.coreEvidenceComplete !== verified.coreEvidenceComplete
    || requireCorrect && (verified.outcome !== "correct" || !verified.coreEvidenceComplete)) {
    throw conflict("当前题的有效步骤证据尚未完成，请保留答案并核对；未推进本题步骤。");
  }
  return observation;
}

export async function assertOpeningSpanRepairTransition(db: Db, scope: Scope, current: SpanLessonSnapshot, input: SpanLessonSaveInput) {
  // A pause preserves exactly the same state even when source/evidence drift makes content unavailable.
  if (input.status === "paused" && input.moveId === current.moveId && isDeepStrictEqual(input.intent, current.intent)) return;
  const plan = await readOpeningSpanStagePlan(db, scope, current.activityId);
  if (!plan) return;
  // Pause is always available without rewriting intent/stage, even for clarification.
  if (!isDeepStrictEqual(input.intent, current.intent)) throw conflict("本题步骤活动不可用偏好更新替换既定计划，请先暂停。");
  if (input.moveId === current.moveId && input.status !== "completed") return;
  if (plan.status !== "ready") throw conflict("请先回原题补写或核对，不能把证据不足标为完成。");
  if (input.status === "completed") {
    if (planIsB(plan)) throw conflict("先修补讲只可通过明确返回原要求结束，不能用通用保存标为完成。");
    if (current.moveId !== "self_study-reserved" || input.moveId !== current.moveId) throw conflict("本题步骤尚未完成新题确认。");
    await stageResult(db, scope, current, "confirmation", false);
    return;
  }
  if (input.status !== "active" || current.status !== "active") throw conflict("请先恢复原学习步骤，再继续。");
  if (current.moveId === "self-example" && input.moveId === "self-faded") {
    const key = planKey(plan, current.activityId, "example");
    const [released] = await db`SELECT 1 AS ok FROM opening_help_exposures h JOIN opening_learning_attempts a ON a.id=h.attempt_id
      AND a.workspace_id=h.workspace_id AND a.owner_user_id=h.owner_user_id AND a.session_id=h.session_id
      WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.activity_id=${current.activityId}
        AND a.session_id=${current.sessionId} AND a.client_key=${key} AND h.release_key=${`${key}:release`}
        AND h.delivered=TRUE AND h.released_at IS NOT NULL AND h.kind='solution' AND h.level='revealed'`;
    if (!released) throw conflict("本题步骤短讲尚未交付，未跳过例题。");
    return;
  }
  if (current.moveId === "self-faded" && input.moveId === "self_study-reserved") {
    await stageResult(db, scope, current, "variant", true);
    return;
  }
  throw conflict("不能跳过本题步骤的例题、变式或新题确认。");
}

/** Also called at canonical attempt creation, closing generic /attempt and old-client bypasses. */
export async function assertOpeningSpanRepairAttempt(db: Db, scope: Scope, activityId: string, input: {
  clientKey: string; spanExercise?: { problemId: string; version: number };
}) {
  const plan = await readOpeningSpanStagePlan(db, scope, activityId);
  if (!plan) return;
  if (plan.status !== "ready" || !input.spanExercise) throw conflict("本题步骤内容尚不可用，未发放通用题目。");
  const [activity] = await db`SELECT checkpoint_json FROM opening_teaching_activities WHERE id=${activityId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  const move = (activity?.checkpoint_json as { spanLesson?: { moveId?: string } })?.spanLesson?.moveId;
  const stage = move === "self-example" ? "example" : move === "self-faded" ? "variant" : move === "self_study-reserved" ? "confirmation" : null;
  if (!stage) throw conflict("题目请求不属于当前本题步骤。");
  const prefix = `${planKey(plan, activityId, "variant")}:retry:`;
  if (stage === "variant" && input.clientKey.startsWith(prefix)) {
    const parentId = input.clientKey.slice(prefix.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parentId)
      || await openingSpanRepairRetryKey(db, scope, activityId, parentId) !== input.clientKey) throw conflict("重答请求不属于当前本题步骤。");
  } else if (input.clientKey !== planKey(plan, activityId, stage)) throw conflict("题目请求不属于当前本题步骤。");
  if (stage !== "confirmation") {
    const identity = stage === "example" ? plan.teachingExample : plan.practiceVariant;
    if (input.spanExercise.problemId !== identity.problemId || String(input.spanExercise.version) !== identity.version) throw conflict("题目身份与本题步骤计划不一致。");
  } else {
    // Stage-specific issuer alone chooses the unseen validation identity. Recheck under the history lock.
    const { readOpeningSpanReservedChoice } = await import("./opening-span-reserved-selection");
    const example = getSpanTeachingProblem(plan.teachingExample.problemId, plan.teachingExample.version)!;
    const choice = await readOpeningSpanReservedChoice(db, scope, "self_study", "validation", example.familyId,
      planIsB(plan) ? (await (await import("./opening-span-course-binding")).readOpeningSpanCourseBinding(db, scope, activityId))?.allowedExerciseKeys : undefined);
    if (choice.kind !== "available" || choice.problem.id !== input.spanExercise.problemId || Number(choice.problem.version) !== input.spanExercise.version) {
      throw conflict("新题确认暂不可发放，未借用其他用途或重复题目。");
    }
  }
}
