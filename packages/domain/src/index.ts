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
export { deriveDayBlocks } from "./opening/day-blocks";
export {
  buildDailyDraftInput,
  dailyDraftClientKey,
  localDateKeyInZone,
  addLocalDays,
  type BuildDailyDraftInputArgs,
  type BuildDailyDraftInputResult,
  type DailyDraftReason,
  type DailyDraftReasonCode,
} from "./opening/daily-draft";
export {
  buildActionDigest,
  applySourceRevision,
  blockerToDigestCandidate,
  compareDigestCandidates,
  resolveDedupeGroup,
  assertDigestHasNoMasteryPercentage,
  deltaTaskIdsForRevision,
  type DigestActionCandidate,
  type DigestActionStatus,
  type ActionDigestView,
} from "./opening/action-digest";
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
  makeTutorInstruction,
  recommendTutorAction,
  recommendAdaptiveTutorAction,
  isAdaptiveTutorRecommendInput,
  exposureLevelForMode as exposureLevelForDeepenMode,
  normalizeDeepenMode,
  assertCitationsForPage,
  assertNoMasteryPercentage,
  freshRetestExposure,
  variantProblemRef,
  PageCitationError,
  type DeepenTutorMode,
  type ThinTutorAction,
  type ThinTutorActionKind,
  type RecommendTutorActionInput,
  type AdaptiveTutorRecommendInput,
  type AdaptiveTutorActionKind,
} from "./opening/tutor-policy";
export {
  RETEST_CLOSE_DEFAULT_DIMENSION,
  nextTutorKindAfterRetestClose,
  nodeIdForSkillLabel,
  prepareRetestSkillLink,
  shouldAppendRetestEvidence,
  type RetestCloseAssistance,
  type RetestCloseDimension,
  type RetestCloseOutcome,
  type RetestSkillLinkFields,
} from "./opening/retest-close-evidence";
export {
  endOfLocalDayIso,
  extractStudyActionCandidates,
  resolveCandidateDueAt,
  type DueResolution,
  type ExtractStudyActionsOptions,
  type ExtractableImportChunk,
} from "./opening/extract-study-actions";
export {
  DEFAULT_STRATEGY_TEMPLATE_ID,
  getStrategyTemplate,
  listStrategyTemplates,
  resolveStrategyTemplate,
  strategyTemplateSchema,
  type StrategyTemplate,
} from "./opening/strategy-registry";


export {
  isMemoryEligible,
  memoriesForContext,
  memoriesForReview,
  memoryCardMeta,
  instructionWithMemories,
} from "./opening/memory-policy";

export { summarizeObservations, type SummarizeOptions, type ObservationEligibilityInput, type CourseEvidence, type QualifiedLearningSummary, type RetestEvidenceIdentity } from "./opening/learning-summary";
export {
  suggestRetestAt,
  buildRetestCandidates,
  DEFAULT_RETEST_DELAY_DAYS,
  DEFAULT_RETEST_BATCH_LIMIT,
  type BuildRetestCandidatesInput,
} from "./opening/retest-policy";
export {
  reminderDeliveryState,
  externalChannelConfigured,
  isWithinQuietHours,
  reminderIdempotencyKey,
  isQueueableDueTask,
  type ReminderChannel,
  type ReminderStatus,
  type ReminderDeliveryInput,
  type QuietHours,
  type ExternalReminderConfig,
  type DueTaskRef,
} from "./opening/reminder-policy";
export {
  isRetestActivityDue,
  reopenRetestActivity,
  transitionRetestActivity,
  RetestActivityTransitionError,
  type RetestActivityCommand,
  type RetestActivityReopenInput,
} from "./opening/retest-activity";
export {
  composeOpeningBackupDraft,
  type OpeningBackupComposeInput,
  type OpeningBackupComposeResult,
  type OpeningBackupComposeRecords,
  type OpeningBackupComposeStaging,
} from "./opening/backup-compose";
export {
  validateOpeningRestore,
  normalizeOpeningRestoreHistory,
  type OpeningBackup,
  type OpeningBackupObject,
  type OpeningDeletionMark,
  type RestorePreview,
} from "./opening/backup-policy";
export {
  planOpeningRestoreApply,
  OPENING_RESTORE_APPLY_ORDER,
  type OpeningRestoreApplyPlan,
  type OpeningRestoreApplyPlanResult,
} from "./opening/backup-apply-plan";
export {
  type OpeningRestoreLearningState,
} from "./opening/backup-learning-state";

export * from "./opening/evidence-eligibility";
export { resolveLearningPreferences } from "./opening/learning-preferences";
export { summarizeLearningAggregate, type AggregateLearningSummary } from "./opening/learning-summary-aggregate";
export {
  validateKnowledgeSnapshot,
  KnowledgeGraphError,
} from "./opening/knowledge-graph";
