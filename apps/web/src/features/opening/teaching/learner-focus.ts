import type { TeachingLearnerFocus } from "@aistudy/contracts";
import { ADAPTIVE_STRATEGY_VERSION, nextLearningStep } from "@aistudy/domain";
import type { LearnerSnapshotRead } from "../planning/learner-snapshot-service";
import { normalizeSkillLabelKey } from "../learning/skill-label-options";

/** No learning facts are inferred from the activity's free-text intention. */
export function teachingLearnerFocus(read: LearnerSnapshotRead, courseId: string, requestedSkill: string | null, wantsFullExplanation: boolean): TeachingLearnerFocus | null {
  const course = read.snapshot.courses.find(row => row.courseId === courseId);
  const source = read.sources.courses.find(row => row.courseId === courseId);
  if (!course || !source || source.evidenceStatus !== "available") return null;
  const label = requestedSkill ?? course.skills.find(skill => skill.status === "needs_review")?.skillLabel
    ?? course.nextSkills[0] ?? course.skills[0]?.skillLabel ?? source.knowledgeNodes[0]?.title;
  if (!label) return null;
  const key = normalizeSkillLabelKey(label);
  const skill = course.skills.find(item => normalizeSkillLabelKey(item.skillLabel) === key);
  const observations = source.observations.filter(row => normalizeSkillLabelKey(row.skillLabel) === key)
    .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt) || a.id.localeCompare(b.id));
  const next = nextLearningStep({ status: skill?.status ?? "unobserved", observations, wantsFullExplanation });
  return { skillLabel: skill?.skillLabel ?? label, ...next,
    recentAssistance: observations.slice(0, 3).map(row => row.assistance), strategyVersion: ADAPTIVE_STRATEGY_VERSION };
}
