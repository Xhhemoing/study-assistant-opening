import type { Sql } from "postgres";
import { teachingLearnerFocusSchema, type Scope, type TeachingLearnerFocus } from "@aistudy/contracts";
import { evaluateEvidenceEligibility, nextLearningStep, normalizeSkillLabelKey, toSnapshotEvidence, type CourseEvidence } from "@aistudy/domain";
import { readOpeningCourseEvidence } from "./opening-learning-read";

/** Task identity comes from the owner-scoped row, not createIntent/goalJson. */
export async function readOpeningTeachingTaskFocus(sql: Sql, scope: Scope, taskId: string) {
  const [task] = await sql`SELECT t.title, t.course_id, t.skill_label,
      COALESCE(t.requirement_key, r.requirement_key) AS requirement_key FROM opening_tasks t
    JOIN workspaces w ON w.id=t.workspace_id AND w.owner_user_id=t.owner_user_id
    LEFT JOIN opening_retest_activities r ON r.task_id=t.id AND r.workspace_id=t.workspace_id AND r.owner_user_id=t.owner_user_id
    WHERE t.id=${taskId} AND t.workspace_id=${scope.workspaceId} AND t.owner_user_id=${scope.ownerUserId}`;
  return task ? {
    title: String(task.title), courseId: task.course_id as string | null,
    skillLabel: task.skill_label as string | null, requirementKey: task.requirement_key as string | null,
  } : null;
}

export type TeachingCompilerFocus = {
  learnerFocus?: TeachingLearnerFocus;
  focusAttempt?: { question: string; answer: string };
};

/** Non-error strategies also expire when their supporting evidence changes. */
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
  if (next.activityKind !== learnerFocus.activityKind) return {};
  return { learnerFocus: { ...learnerFocus,
    recentAssistance: observations.filter(row => row.usableForCurrentVersion === "yes").slice(0, 3).map(row => row.assistance),
  } };
}

/** Only the chosen effective observation's question and answer may enter the prompt. */
export async function readOpeningTeachingCompilerFocus(sql: Sql, scope: Scope, activityId: string): Promise<TeachingCompilerFocus> {
  const [activity] = await sql`SELECT a.goal_json, a.course_id FROM opening_teaching_activities a
    JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
    WHERE a.id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  const parsed = teachingLearnerFocusSchema.safeParse(activity?.goal_json?.learnerFocus);
  if (!parsed.success) return {};
  const learnerFocus = parsed.data;
  if (!learnerFocus.focusObservationId && (learnerFocus.activityKind === "full_explain" || learnerFocus.activityKind === "diagnose")) return { learnerFocus };
  if (!activity?.course_id) return {};
  const evidence = await readOpeningCourseEvidence(sql, scope, String(activity.course_id));
  if (!learnerFocus.focusObservationId) return recheckDerivedFocus(learnerFocus, evidence);
  const observation = evidence.observations.find(row => row.id === learnerFocus.focusObservationId);
  const eligibility = observation && evidence.evidenceContexts[observation.id];
  // Historical correctness alone cannot qualify an answer for the current material.
  if (!observation || !eligibility) return {};
  if (learnerFocus.requirementKey !== undefined && (
    learnerFocus.requirementKey !== (observation.requirementKey ?? null) ||
    normalizeSkillLabelKey(learnerFocus.skillLabel) !== normalizeSkillLabelKey(observation.skillLabel)
  )) return {};
  const qualified = evaluateEvidenceEligibility(eligibility.observation, eligibility.context);
  if (qualified.verifiedCorrect !== "no" || qualified.usableForCurrentVersion !== "yes") return {};
  const [problem] = observation.problemId ? await sql`SELECT p.stem_snapshot FROM opening_problem_refs p
    JOIN workspaces w ON w.id=p.workspace_id AND w.owner_user_id=${scope.ownerUserId}
    WHERE p.problem_id=${observation.problemId} AND p.workspace_id=${scope.workspaceId}` : [];
  return { learnerFocus, ...(problem?.stem_snapshot ? {
    focusAttempt: { question: String(problem.stem_snapshot).slice(0, 2000), answer: observation.answer.slice(0, 4000) },
  } : {}) };
}
