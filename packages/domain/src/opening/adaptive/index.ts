export {
  ADAPTIVE_STRATEGY_VERSION,
  parseSuggestionKey,
  stableHash,
  suggestionIdentity,
  suggestionKey,
  taskCourseId,
  taskSkillLabel,
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

/** Conversation intent -> evidence-aware teaching proposal -> replan preview (no writes). */
export {
  resolveConversationIntent,
  proposeLearningSession,
  previewEvidenceTriggeredReplan,
  type ConversationStudyIntent,
  type IntentCandidate,
  type IntentResolution,
  type IntentIssue,
  type LearningEvidenceSnapshot,
  type LearningStep,
  type LearningStepKind,
  type LearningSessionProposal,
} from "./conversation-learning";

export { buildConversationTaskDraft, type ConversationTaskDraft } from "./conversation-task-draft";
