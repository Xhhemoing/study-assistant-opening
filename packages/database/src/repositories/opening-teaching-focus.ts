import type { Sql } from "postgres";
import { knowledgeSnapshotSchema, teachingLearnerFocusSchema, type Scope, type TeachingLearnerFocus } from "@aistudy/contracts";
import { evaluateEvidenceEligibility, nextLearningStep, normalizeSkillLabelKey, selectPrerequisiteRepair, toSnapshotEvidence, toSupportedKnowledgeNodes, type CourseEvidence } from "@aistudy/domain";
import { readOpeningCourseEvidence } from "./opening-learning-read";
import { plannerSuggestionKind } from "./opening-task-fields";
import { readOpeningLearnerSnapshotCourses } from "./opening-learner-snapshot-read";

/** Task identity comes from the owner-scoped row, not createIntent/goalJson. */
export async function readOpeningTeachingTaskFocus(sql: Sql, scope: Scope, taskId: string) {
  const [task] = await sql`SELECT t.title, t.course_id, t.skill_label, t.origin, t.client_key,
      COALESCE(t.requirement_key, r.requirement_key) AS requirement_key FROM opening_tasks t
    JOIN workspaces w ON w.id=t.workspace_id AND w.owner_user_id=t.owner_user_id
    LEFT JOIN opening_retest_activities r ON r.task_id=t.id AND r.workspace_id=t.workspace_id AND r.owner_user_id=t.owner_user_id
    WHERE t.id=${taskId} AND t.workspace_id=${scope.workspaceId} AND t.owner_user_id=${scope.ownerUserId}`;
  return task ? {
    title: String(task.title), courseId: task.course_id as string | null,
    skillLabel: task.skill_label as string | null, requirementKey: task.requirement_key as string | null,
    suggestionKind: plannerSuggestionKind(task),
    clientKey: (task.origin === "manual" || task.origin === "course_seed") && task.client_key ? String(task.client_key) : undefined,
  } : null;
}

export type TeachingCompilerFocus = {
  learnerFocus?: TeachingLearnerFocus;
  focusAttempt?: { question: string; answer: string };
};

/** Reuse the planner's current-evidence policy, including newer attempts after task creation. */
function recheckDerivedFocus(learnerFocus: TeachingLearnerFocus, evidence: CourseEvidence): TeachingCompilerFocus {
  const mapped = toSnapshotEvidence(evidence, new Date());
  const labelKey = normalizeSkillLabelKey(learnerFocus.skillLabel);
  const summaries = mapped.summaries.filter(row => normalizeSkillLabelKey(row.skillLabel) === labelKey
    && (learnerFocus.requirementKey === undefined || (row.requirementKey ?? null) === learnerFocus.requirementKey));
  if (summaries.length !== 1) return {};
  const target = summaries[0]!;
  const observations = mapped.observations.filter(row => normalizeSkillLabelKey(row.skillLabel) === labelKey
    && (row.requirementKey ?? null) === (target.requirementKey ?? null))
    .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt) || a.id.localeCompare(b.id));
  const next = nextLearningStep({ status: target.status, observations, wantsFullExplanation: false });
  if (!observations.some(row => row.usableForCurrentVersion === "yes")) return {};
  if (next.activityKind !== learnerFocus.activityKind || next.focusObservationId !== learnerFocus.focusObservationId) {
    const { recentErrors: _errors, prerequisiteRepair: _repair, ...base } = learnerFocus;
    const focused = observations.find(row => row.id === next.focusObservationId);
    return { learnerFocus: { ...base, ...next,
      recentAssistance: observations.filter(row => row.usableForCurrentVersion === "yes").slice(0, 3).map(row => row.assistance),
      ...(focused?.errors?.length ? { recentErrors: focused.errors } : {}),
    } };
  }
  return { learnerFocus: { ...learnerFocus,
    recentAssistance: observations.filter(row => row.usableForCurrentVersion === "yes").slice(0, 3).map(row => row.assistance),
  } };
}

/** A goal is the activity's policy snapshot; expired answer evidence must not erase it. */
function withoutCurrentEvidence(focus: TeachingLearnerFocus): TeachingCompilerFocus {
  if (!focus.goalContext) return {};
  const { prerequisiteRepair: _repair, recentErrors: _errors, ...base } = focus;
  return { learnerFocus: { ...base, activityKind: "diagnose", reasonCode: "no_evidence",
    focusObservationId: null, recentAssistance: [] } };
}

async function recheckPrerequisite(
  sql: Sql, scope: Scope, courseId: string | null, focus: TeachingLearnerFocus, evidence?: CourseEvidence,
): Promise<TeachingLearnerFocus> {
  if (!focus.prerequisiteRepair) return focus;
  const { prerequisiteRepair: previous, ...base } = focus;
  if (!courseId || !focus.goalContext || !evidence || focus.activityKind === "transfer_check") return base;
  // Reuse the planner's source-version, privacy and membership qualification.
  // The raw knowledge repository also returns historical graphs, which cannot
  // authorize a current teaching detour after a material is replaced/unlinked.
  const current = await readOpeningLearnerSnapshotCourses(sql, scope);
  const graph = knowledgeSnapshotSchema.safeParse(current.find(course => course.courseId === courseId)?.knowledgeSnapshot);
  if (!graph.success) return base;
  const now = new Date();
  const candidate = selectPrerequisiteRepair({ targetSkillLabel: focus.skillLabel,
    knowledgeNodes: toSupportedKnowledgeNodes(graph.data), observations: toSnapshotEvidence(evidence, now).observations,
    goalContext: focus.goalContext, now });
  // Rebuilds may replace node IDs. Never attach an old detour to a new graph.
  if (!candidate || candidate.nodeId !== previous.nodeId || candidate.targetNodeId !== previous.targetNodeId
    || normalizeSkillLabelKey(candidate.skillLabel) !== normalizeSkillLabelKey(previous.skillLabel)
    || normalizeSkillLabelKey(candidate.returnToSkillLabel) !== normalizeSkillLabelKey(previous.returnToSkillLabel)) return base;
  return { ...base, prerequisiteRepair: candidate };
}

async function withFocusAttempt(sql: Sql, scope: Scope, learnerFocus: TeachingLearnerFocus,
  evidence: CourseEvidence): Promise<TeachingCompilerFocus> {
  const observation = evidence.observations.find(row => row.id === learnerFocus.focusObservationId);
  // Use the submitted version, never the mutable problem reference's current wording.
  const [problem] = observation?.itemVersionId ? await sql`SELECT v.stem_snapshot FROM opening_learning_item_versions v
    WHERE v.id=${observation.itemVersionId} AND v.problem_id=${observation.problemId!}
      AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}` : [];
  return { learnerFocus, ...(problem?.stem_snapshot && observation ? {
    focusAttempt: { question: String(problem.stem_snapshot).slice(0, 2000), answer: observation.answer.slice(0, 4000) },
  } : {}) };
}

/** Only the chosen effective observation's question and answer may enter the prompt. */
export async function readOpeningTeachingCompilerFocus(sql: Sql, scope: Scope, activityId: string): Promise<TeachingCompilerFocus> {
  const [activity] = await sql`SELECT a.goal_json, a.course_id FROM opening_teaching_activities a
    JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
    WHERE a.id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  const parsed = teachingLearnerFocusSchema.safeParse(activity?.goal_json?.learnerFocus);
  if (!parsed.success) return {};
  const courseId = activity?.course_id ? String(activity.course_id) : null;
  const storedFocus = parsed.data;
  const needsEvidence = Boolean(storedFocus.prerequisiteRepair || storedFocus.focusObservationId
    || (storedFocus.activityKind !== "full_explain" && storedFocus.activityKind !== "diagnose"));
  const evidence = needsEvidence && courseId ? await readOpeningCourseEvidence(sql, scope, courseId) : undefined;
  const learnerFocus = await recheckPrerequisite(sql, scope, courseId, storedFocus, evidence);
  if (!learnerFocus.focusObservationId && (learnerFocus.activityKind === "full_explain" || learnerFocus.activityKind === "diagnose")) return { learnerFocus };
  if (!evidence) return withoutCurrentEvidence(learnerFocus);
  if (!learnerFocus.focusObservationId) {
    const checked = recheckDerivedFocus(learnerFocus, evidence);
    return checked.learnerFocus ? withFocusAttempt(sql, scope, checked.learnerFocus, evidence) : withoutCurrentEvidence(learnerFocus);
  }
  const observation = evidence.observations.find(row => row.id === learnerFocus.focusObservationId);
  const eligibility = observation && evidence.evidenceContexts[observation.id];
  // Historical correctness alone cannot qualify an answer for the current material.
  if (!observation || !eligibility) return withoutCurrentEvidence(learnerFocus);
  if (learnerFocus.requirementKey !== undefined && (
    learnerFocus.requirementKey !== (observation.requirementKey ?? null) ||
    normalizeSkillLabelKey(learnerFocus.skillLabel) !== normalizeSkillLabelKey(observation.skillLabel)
  )) return withoutCurrentEvidence(learnerFocus);
  const qualified = evaluateEvidenceEligibility(eligibility.observation, eligibility.context);
  if (qualified.verifiedCorrect !== "no" || qualified.usableForCurrentVersion !== "yes") return withoutCurrentEvidence(learnerFocus);
  const refreshed = recheckDerivedFocus(learnerFocus, evidence);
  if (!refreshed.learnerFocus) return withoutCurrentEvidence(learnerFocus);
  return withFocusAttempt(sql, scope, refreshed.learnerFocus, evidence);
}
