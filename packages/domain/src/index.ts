/**
 * Pure domain package — no UI/DB/Redis imports.
 * Workspace smoke symbol used by monorepo quality gates.
 */
export const PLATFORM_NAME = "AIstudy" as const;

export type SummaryBand = "stable" | "usable" | "weak" | "untested";

export function isSummaryBand(value: string): value is SummaryBand {
  return (
    value === "stable" ||
    value === "usable" ||
    value === "weak" ||
    value === "untested"
  );
}

export { SRS_VERSION, createInitialState, scheduleReview } from "./srs/scheduler";
export {
  buildReviewQueue,
  isCardEligibleForMode,
  reviewEligibilityForMode,
  type ReviewEligibility,
  type ReviewQueueItem,
} from "./srs/eligibility";
export {
  ASSESSMENT_VERSION,
  ASSESSMENT_MODEL_VERSION,
  deriveStatus,
  reviewGradeToEvidence,
  type AssessmentOptions,
  type AssessmentSlice,
  type EvidenceEvent,
  type EvidenceSource,
  type StatusCorrection,
} from "./assessment/status";
export { evidenceFromLearningEvent, correctionFromLearningEvent } from "./assessment/from-events";
export { disabledSlicesFromWeights } from "./assessment/slices";
export {
  PLANNER_VERSION,
  buildTodayPlan,
  type PlannerInput,
  type PlannerPointInput,
  type PlannerGoalInput,
} from "./planning/planner";
export { applyPlanOption, needsOptionChoice } from "./planning/choice";
export { availableTimeSlots } from "./opening/planning-time";
export { planDay, type DayPlanResult } from "./opening/day-planner";
export {
  expandWeekSessions,
  normalizeWeekSessions,
} from "./opening/timetable";
export type { TimeBlock, WeekSession } from "@aistudy/contracts";
export { scenarioToGoalKind } from "./planning/kinds";
export { rankResults, type SearchDoc, type SearchHit } from "./search/query";
export { gradePracticeAnswer, isPracticeAnswerCorrect, normalizeAnswer } from "./practice/grading";
export {
  INTERVENTION_VERSION,
  actionForCause,
  classifyError,
  planIntervention,
  type InterventionAction,
  type InterventionHint,
  type InterventionPlan,
  type InterventionPriority,
} from "./practice/intervention";
export {
  generateInterventionContent,
  generateReviewCard,
  generateStepGuide,
  generateVariant,
  type GeneratedIntervention,
  type GeneratedReviewCard,
  type GeneratedStepGuide,
  type GeneratedVariant,
} from "./practice/intervention-content";
export {
  assertNonEmptyRevisionBlocks,
  diffRevisionBlocks,
  selectProposalBlocks,
  preserveBothBlocks,
} from "./revisions/proposals";
export {
  REQUIREMENT_PROFILE_VERSION,
  REQUIREMENT_PROFILES,
  REQUIREMENT_PROFILES_BY_KIND,
  getRequirementProfile,
  resolveRequirementProfile,
  listRequirementProfileKinds,
  isAssessmentEnabled,
  validateAbilityWeights,
  normalizeAbilityWeights,
  type RequirementPreset,
} from "./courses/requirements";
export {
  EFFECTIVE_REQUIREMENTS_VERSION,
  defaultGoalAbilities,
  computeEffectiveRequirements,
  type GoalKind,
  type GoalRequirement,
  type TimeWindow,
  type TimeWindowPhase,
  type UserOverride,
  type EffectiveRequirements,
} from "./goals/effective-requirements";
export {
  exportMarkdown,
  exportMarkdownBundle,
  importMarkdown,
  libraryDocumentToPortable,
  blockMarker,
  type PortableBlock,
  type PortableDocument,
  type PortableSourceFile,
  type MarkdownDocumentExport,
  type MarkdownImportResult,
} from "./portability/markdown";
export { exportAnkiDeck, type AnkiDeckInput, type AnkiSourceCard } from "./portability/anki";
export { NATIVE_BACKUP_TABLES, RESTORE_TOPOLOGY } from "./portability/native/types";
export { NativeBackupError } from "./portability/native/errors";
export type {
  ExistingBackupIds,
  NativeBackupFileInput,
  NativeBackupRecord,
  NativeBackupSnapshot,
  RestoreCollection,
} from "./portability/native/types";
export type { NativeRestorePlan } from "./portability/native/restore";
export {
  GUIDANCE_POLICY_VERSION,
  getGuidancePolicy,
  canReorderTask,
  slotsOverlap,
  canScheduleIntoSlot,
  reserveProtectedSlot,
  type GuidanceMode,
  type GuidancePolicy,
  type ReorderTarget,
  type TimeSlot,
} from "./guidance/guidance";

export {
  resolveAssistance,
  qualifyObservationAssistance,
  type AssistanceLevel,
  type HelpExposureLevel,
  type ObservationOutcome,
} from "./opening/assistance";

export {
  isMemoryEligible,
  memoriesForContext,
  memoriesForReview,
  memoryCardMeta,
} from "./opening/memory-policy";

export { summarizeObservations, type SummarizeOptions } from "./opening/learning-summary";
export {
  suggestRetestAt,
  buildRetestCandidates,
  DEFAULT_RETEST_DELAY_DAYS,
  DEFAULT_RETEST_BATCH_LIMIT,
  type BuildRetestCandidatesInput,
} from "./opening/retest-policy";
