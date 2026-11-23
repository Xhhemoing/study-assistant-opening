import type { TeachingLearnerFocus } from "@aistudy/contracts";
import {
  ADAPTIVE_STRATEGY_VERSION, buildDecisionInput, nextLearningStep, resolveGoalLearningContext,
  resolvePrerequisiteDrilldown, selectPrerequisiteRepair, type PrerequisiteDrilldownContext, type SkillPlacementRoute,
} from "@aistudy/domain";
import type { LearnerSnapshotRead } from "../planning/learner-snapshot-service";
import { normalizeSkillLabelKey } from "../learning/skill-label-options";

/** No learning facts are inferred from the activity's free-text intention. */
export function teachingLearnerFocus(read: LearnerSnapshotRead, courseId: string, requestedSkill: string | null,
  wantsFullExplanation: boolean, requestedRequirementKey?: string | null, now = new Date(), options?: {
    placementRoutesByNodeId?: ReadonlyMap<string, SkillPlacementRoute>;
    drilldown?: PrerequisiteDrilldownContext;
  }): TeachingLearnerFocus | null {
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
  const goalContext = resolveGoalLearningContext(source.goal, read.sources.date);
  const repairInput = { targetSkillLabel: skill?.skillLabel ?? label,
    knowledgeNodes: source.knowledgeNodes, observations: source.observations, goalContext, now };
  const drilldown = options?.drilldown
    ? resolvePrerequisiteDrilldown({ ...repairInput, drilldown: options.drilldown }) : null;
  const nodes = options?.placementRoutesByNodeId
    ? source.knowledgeNodes.filter(node => normalizeSkillLabelKey(node.title) === key) : [];
  const placementRoute = nodes.length === 1 ? options?.placementRoutesByNodeId?.get(nodes[0]!.id) : undefined;
  const decisionInput = buildDecisionInput({
    observations: source.observations.filter(row => hasTarget
      && normalizeSkillLabelKey(row.skillLabel) === key && (row.requirementKey ?? null) === requirementKey),
    wantsFullExplanation,
    placementRoute,
    drilldownSnapshot: drilldown?.snapshot,
  });
  const { observations } = decisionInput;
  const { activityKind, focusObservationId, reasonCode } = nextLearningStep(decisionInput);
  const prerequisiteRepair = activityKind === "transfer_check" ? null
    : options?.drilldown ? drilldown?.prerequisiteRepair : selectPrerequisiteRepair(repairInput);
  return { skillLabel: skill?.skillLabel ?? label, ...(hasTarget ? { requirementKey } : {}), activityKind, focusObservationId, reasonCode,
    recentErrors: observations.filter(row => row.usableForCurrentVersion === "yes").flatMap(row => row.errors ?? []).slice(0, 3),
    goalContext, ...(prerequisiteRepair ? { prerequisiteRepair } : {}),
    recentAssistance: observations.filter(row => row.usableForCurrentVersion === "yes").slice(0, 3).map(row => row.assistance), strategyVersion: ADAPTIVE_STRATEGY_VERSION };
}
