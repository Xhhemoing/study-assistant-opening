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
export {
  NATIVE_BACKUP_TABLES,
  RESTORE_TOPOLOGY,
  NativeBackupError,
  buildNativeBackup,
  emptyBackupCounts,
  planNativeRestore,
  sha256Hex,
  type ExistingBackupIds,
  type NativeBackupFileInput,
  type NativeBackupRecord,
  type NativeBackupSnapshot,
  type NativeRestorePlan,
  type RestoreCollection,
} from "./portability/native";
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
