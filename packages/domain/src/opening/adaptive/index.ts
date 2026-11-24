export {
  ADAPTIVE_STRATEGY_VERSION,
  parseSuggestionKey,
  stableHash,
  suggestionIdentity,
  suggestionKey,
  taskCourseId,
  taskSkillLabel,
  taskRequirementKey,
  type Assistance,
  type CourseSignal,
  type LearnerSnapshot,
  type PlannerHistoryEntry,
  type SkillSignal,
  type SkillStatus,
} from "./types";
export {
  MAX_DAILY_SUGGESTIONS,
  SUGGESTION_CAPACITY_SHARE,
  isCourseBehind,
  proposeAdaptiveTasks,
  type ProposeAdaptiveTasksOptions,
} from "./propose-tasks";
export {
  MAX_SAME_COURSE_RUN,
  interleaveCourses,
  rankForPlan,
  suggestionsAsTasks,
  type RankForPlanInput,
  type RankForPlanResult,
} from "./rank-for-plan";
export {
  autonomyGuidanceMode,
  decideCoachAutoAccept,
  type CoachDecision,
  type CoachDecisionInput,
  type CoachDenyReason,
} from "./autonomy";
export { MIN_FREED_MINUTES, shouldOfferReplan, type ReplanOffer } from "./replan-trigger";
export type {
  LearnerSnapshotSources,
  NextLearningStep,
  NextLearningStepInput,
  NextStepReasonCode,
  SnapshotCourseSource,
  SnapshotDataStatus,
  SnapshotKnowledgeNode,
  SnapshotObservation,
  SnapshotSkillSummary,
  SnapshotTaskRow,
  LearningPhase,
  LearningPhaseSource,
  MetacognitiveConfidenceContext,
} from "./snapshot-sources";
export { assembleLearnerSnapshot } from "./assemble-snapshot";
export { nextLearningStep, captureNextLearningStep, learningPhaseForInput, withLearningPhase, NEXT_LEARNING_STEP_VERSION } from "./next-learning-step";
export { resolveGoalLearningContext, goalPlanningPriority, goalPlanningReason } from "./goal-policy";
export { toSupportedKnowledgeNodes, selectPrerequisiteRepair, resolvePrerequisiteDrilldown, type PrerequisiteDrilldownContext } from "./prerequisite-repair";
export { buildAdaptivePlacement, type AdaptivePlacement, type AdaptivePlacementInput } from "./placement-bridge";
export {
  generateAdaptiveRemedyClinic, revalidateAdaptiveRemedyClinics,
  type AdaptiveRemedyClinicCandidate, type AdaptiveRemedyClinicValidation,
} from "./remedy-clinic-bridge";
export { adaptiveSkillIdentity, normalizeSkillLabelKey } from "./skill-identity";
export { toSnapshotEvidence } from "./snapshot-evidence";

export * from "./loop-metrics";

export * from "./local-replan";

export * from "./suggestion-feedback";
export {
  buildSkillBeliefTrajectory, compareLearnerShadowV2, evaluateWheelSpinningGuard,
  planAdaptiveBellmanShadow, predictLearnerShadowV2,
  type AdaptiveEpistemicShadowInput, type AdaptiveWheelSpinningInput, type AdaptiveBellmanShadowInput,
  type SkillBeliefTrajectoryInput,
} from "./metacognitive-epistemic-bridge";
export * from "./experimental-bkt-advice";
