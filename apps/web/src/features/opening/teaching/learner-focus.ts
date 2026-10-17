import type { TeachingLearnerFocus } from "@aistudy/contracts";
import { ADAPTIVE_STRATEGY_VERSION, nextLearningStep, resolveGoalLearningContext, selectPrerequisiteRepair } from "@aistudy/domain";
import type { LearnerSnapshotRead } from "../planning/learner-snapshot-service";
import { normalizeSkillLabelKey } from "../learning/skill-label-options";

/** No learning facts are inferred from the activity's free-text intention. */
export function teachingLearnerFocus(read: LearnerSnapshotRead, courseId: string, requestedSkill: string | null, wantsFullExplanation: boolean, requestedRequirementKey?: string | null, now = new Date()): TeachingLearnerFocus | null {
  const course = read.snapshot.courses.find(row => row.courseId === courseId);
  const source = read.sources.courses.find(row => row.courseId === courseId);
  if (!course || !source || source.evidenceStatus !== "available") return null;
  const defaultSkill = requestedSkill === null
    ? course.skills.find(skill => skill.status === "needs_review") ?? (course.nextSkills.length ? undefined : course.skills[0])
    : undefined;
  const label = requestedSkill ?? defaultSkill?.skillLabel ?? course.nextSkills[0] ?? source.knowledgeNodes[0]?.title;
  if (!label) return null;
  const key = normalizeSkillLabelKey(label);
  const matches = course.skills.filter(item => normalizeSkillLabelKey(item.skillLabel) === key);
  const skill = requestedRequirementKey !== undefined
    ? matches.find(item => (item.requirementKey ?? null) === requestedRequirementKey)
    : defaultSkill ?? (matches.length === 1 ? matches[0] : undefined);
  // A label-only legacy task must not borrow the first of several requirements.
  const hasTarget = skill !== undefined || requestedRequirementKey !== undefined;
  const requirementKey = requestedRequirementKey ?? skill?.requirementKey ?? null;
  const observations = source.observations.filter(row => hasTarget
    && normalizeSkillLabelKey(row.skillLabel) === key && (row.requirementKey ?? null) === requirementKey)
    .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt) || a.id.localeCompare(b.id));
  const next = nextLearningStep({ status: skill?.status ?? "unobserved", observations, wantsFullExplanation });
  const goalContext = resolveGoalLearningContext(source.goal, read.sources.date);
  const prerequisiteRepair = next.activityKind === "transfer_check" ? null : selectPrerequisiteRepair({ targetSkillLabel: skill?.skillLabel ?? label,
    knowledgeNodes: source.knowledgeNodes, observations: source.observations, goalContext, now });
  return { skillLabel: skill?.skillLabel ?? label, ...(hasTarget ? { requirementKey } : {}), ...next,
    goalContext, ...(prerequisiteRepair ? { prerequisiteRepair } : {}),
    recentAssistance: observations.filter(row => row.usableForCurrentVersion === "yes").slice(0, 3).map(row => row.assistance), strategyVersion: ADAPTIVE_STRATEGY_VERSION };
}
