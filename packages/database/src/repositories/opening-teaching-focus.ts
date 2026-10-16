import type { Sql } from "postgres";
import { teachingLearnerFocusSchema, type Scope, type TeachingLearnerFocus } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { readOpeningCourseEvidence } from "./opening-learning-read";

/** Task identity comes from the owner-scoped row, not createIntent/goalJson. */
export async function readOpeningTeachingTaskFocus(sql: Sql, scope: Scope, taskId: string) {
  const [task] = await sql`SELECT t.title, t.course_id, t.skill_label FROM opening_tasks t
    JOIN workspaces w ON w.id=t.workspace_id AND w.owner_user_id=t.owner_user_id
    WHERE t.id=${taskId} AND t.workspace_id=${scope.workspaceId} AND t.owner_user_id=${scope.ownerUserId}`;
  return task ? { title: String(task.title), courseId: task.course_id as string | null, skillLabel: task.skill_label as string | null } : null;
}

export type TeachingCompilerFocus = {
  learnerFocus?: TeachingLearnerFocus;
  focusAttempt?: { question: string; answer: string };
};

/** Only the chosen effective observation's question and answer may enter the prompt. */
export async function readOpeningTeachingCompilerFocus(sql: Sql, scope: Scope, activityId: string): Promise<TeachingCompilerFocus> {
  const [activity] = await sql`SELECT a.goal_json, a.course_id FROM opening_teaching_activities a
    JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
    WHERE a.id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  const parsed = teachingLearnerFocusSchema.safeParse(activity?.goal_json?.learnerFocus);
  if (!parsed.success) return {};
  const learnerFocus = parsed.data;
  if (!learnerFocus.focusObservationId) return { learnerFocus };
  if (!activity?.course_id) return {};
  const evidence = await readOpeningCourseEvidence(sql, scope, String(activity.course_id));
  const observation = evidence.observations.find(row => row.id === learnerFocus.focusObservationId);
  const eligibility = observation && evidence.evidenceContexts[observation.id];
  // Revision, withdrawal or changed material must not resurrect the old wrong answer.
  if (!observation || !eligibility || evaluateEvidenceEligibility(eligibility.observation, eligibility.context).verifiedCorrect !== "no") return {};
  const [problem] = observation.problemId ? await sql`SELECT stem_snapshot FROM opening_problem_refs
    WHERE problem_id=${observation.problemId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}` : [];
  return { learnerFocus, ...(problem?.stem_snapshot ? {
    focusAttempt: { question: String(problem.stem_snapshot).slice(0, 2000), answer: observation.answer.slice(0, 4000) },
  } : {}) };
}
