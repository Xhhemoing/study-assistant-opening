import { uuidSchema, type LearningAttemptSubmitInput, type TaskRetestProjection } from "@aistudy/contracts";

/** Prefill for a learning attempt bound to an accepted retest proposal. */
export type RetestAttemptPrefill = {
  retestId: string;
  skillLabel: string;
  prompt: string;
};

/** Course practice deep link for a due retest task. */
export function retestPracticeHref(courseId: string, candidateId: string): string {
  return `/opening/courses/${courseId}?retest=${candidateId}#course-practice`;
}

export function parseRetestCandidateId(value: string | null | undefined): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function retestPrefillFromProjection(retest: TaskRetestProjection): RetestAttemptPrefill {
  return {
    retestId: retest.candidateId,
    skillLabel: retest.skillLabel,
    prompt: retest.prompt,
  };
}

/** True when the selected task is a retest that is already due (or has no recommendedAt). */
export function isDueRetestSelection(task: { status?: string; retest?: TaskRetestProjection | null }, now = new Date()): boolean {
  if (task.status !== "pending" || task.retest == null) return false;
  const at = task.retest.recommendedAt;
  if (at == null || at === "") return true;
  return new Date(at).getTime() <= now.getTime();
}

/** Attach retestId to a submit body without inventing other fields. */
export function withRetestSubmit(
  input: Omit<LearningAttemptSubmitInput, "retestId">,
  retestId: string | null | undefined,
): LearningAttemptSubmitInput {
  if (!retestId) return input;
  return { ...input, retestId };
}

/** Resolve prefill from a task list for a ?retest=<candidateId> deep link. */
export function findRetestPrefill(
  tasks: Array<{ retest?: TaskRetestProjection | null }>,
  candidateId: string,
): RetestAttemptPrefill | null {
  for (const task of tasks) {
    if (task.retest?.candidateId === candidateId) return retestPrefillFromProjection(task.retest);
  }
  return null;
}
