export const DATABASE_PACKAGE = "@aistudy/database" as const;
export * from "./schema/library";
export * from "./schema/courses";
export * from "./schema/goals";
export * from "./schema/identity";
export * from "./schema/preferences";
export * from "./schema/explorations";
export * from "./repositories/library";
export * from "./repositories/course-membership";
export * from "./repositories/identity";
export * from "./repositories/preferences";
export * from "./repositories/opening-learning-preferences";
export * from "./repositories/explorations";
export * from "./migrate";
export * from "./schema/promotions";
export * from "./repositories/promotions";
export * from "./schema/revision-proposals";
export * from "./repositories/revision-proposals";
export * from "./schema/learning-events";
export * from "./repositories/learning-events";
export * from "./schema/cards";
export * from "./repositories/cards";
export * from "./schema/practice-content";
export * from "./repositories/practice-content";
export * from "./repositories/practice-sessions";
export * from "./repositories/backup-restore";
export * from "./migration-preflight";
export * from "./schema/opening-sources";
export * from "./schema/opening-source-chunks";
export * from "./repositories/opening-sources";
export { reserveOpeningSourceQuota } from "./repositories/opening-source-quota";
export { readOpeningMaterialOrganization } from "./repositories/opening-material-organization";
export {
  listReadySourceIdsForCourse,
  createOpeningCourseReadySourcesRepository,
  READY_COURSE_SOURCE_IDS_CAP,
  type OpeningCourseReadySourcesRepository,
} from "./repositories/opening-course-ready-sources";
export { readOpeningSourceContent } from "./repositories/opening-source-content";
export * from "./repositories/opening-source-actions";
export { createOpeningEphemeralProvenanceRepository, EphemeralProvenanceError, type EphemeralProvenanceRepository } from "./repositories/opening-ephemeral-provenance";
export { createOpeningNoteRepository, OpeningNoteError, type SnippetNoteBlock } from "./repositories/opening-note-provenance";
export * from "./repositories/opening-source-chunks";
export * from "./schema/opening-learning";
export * from "./repositories/opening-learning";
export * from "./repositories/opening-conversations";
export * from "./repositories/opening-conversation-selection";
export * from "./schema/opening-jobs";
export * from "./schema/opening-budget";
export * from "./repositories/opening-jobs";
export * from "./repositories/opening-budget";
export * from "./storage/opening-s3";
export { magicMatchesMime } from "./storage/magic";

export * from "./schema/opening-assistant-candidates";
export * from "./repositories/opening-candidates";
export * from "./repositories/opening-tutor-jobs";
export * from "./repositories/opening-context-provenance";

export * from "./schema/opening-memory";
export * from "./repositories/opening-memory";
export * from "./repositories/opening-memory-replace";

export * from "./repositories/opening-privacy";
export * from "./repositories/opening-retests";
export * from "./schema/opening-planning";
export * from "./schema/opening-plan-feedback";
export { readOpeningPlanFeedbackSummary } from "./repositories/opening-plan-feedback";
export * from "./repositories/opening-plans";
export { createOpeningFirstLearningRepository, type OpeningFirstLearningRepository, type FirstLearningDaySeed,
  type FirstLearningInitializationInput, type FirstLearningInitializationResult } from "./repositories/opening-first-learning";
export * from "./repositories/opening-reminders";
export * from "./repositories/opening-connections";
export * from "./schema/opening-imports";
export * from "./repositories/opening-imports";
export {
  createOpeningImportChunksRepository,
  listAuthorizedImportChunks,
  channelFromConnectionKind,
  type OpeningImportChunksRepository,
} from "./repositories/opening-import-chunks";
export * from "./repositories/opening-model-providers";
export * from "./schema/opening-connections";
export * from "./storage/opening-credential-vault";
export * from "./repositories/opening-review-candidates";
export * from "./schema/opening-retest-activities";
export * from "./repositories/opening-retest-activities";

export * from "./repositories/opening-learning-evidence-context";
export * from "./repositories/opening-learning-attempts";
export * from "./repositories/opening-learning-read";
export * from "./repositories/opening-learner-snapshot-read";
export {
  mapLearningObservation,
  probeLearningSourcesAvailability,
} from "./repositories/opening-learning-facts";
export * from "./schema/opening-learning-attempts";
export * from "./repositories/opening-observation-revisions";

export { createOpeningAiSettingsRepository, setOpeningAiSettingsInTx } from "./repositories/opening-ai-settings";
export { createScopedOpeningSystemQueryReader, type SystemQueryPublicSettings } from "./repositories/opening-system-query";
export { readOpeningSystemQueryAuthorization, SystemQueryPermissionError } from "./repositories/opening-system-query-admission";
export * from "./schema/opening-query-provenance";
export { createOpeningPlanningSettingsRepository } from "./repositories/opening-planning-settings";
export { createOpeningAdaptivePrefsRepository, type OpeningAdaptivePrefsRepository } from "./repositories/opening-adaptive-prefs";
export { createOpeningInterventionSettingsRepository } from "./repositories/opening-intervention-settings";
export { DEFAULT_OPENING_PLANNING_SETTINGS } from "@aistudy/contracts";
export { readOpeningCourseLearningHistory } from "./repositories/opening-learning-history-read";
export * from "./repositories/opening-learning-eligibility";
export { readOpeningCourseLearningSummary } from "./repositories/opening-learning-summary-read";

export * from "./schema/opening-knowledge";
export {
  createOpeningKnowledgeRepository,
  OpeningKnowledgeError,
  type OpeningKnowledgeRepository,
  type OpeningKnowledgeRecord,
  type AuthorizedKnowledgeChunk,
  type ReplaceKnowledgeInput,
} from "./repositories/opening-knowledge";

export * from "./schema/opening-skill-evidence";
export {
  createOpeningSkillEvidenceRepository,
  linkOpeningSkillEvidenceInTx,
  type OpeningSkillEvidenceRepository,
  type LinkSkillEvidenceInput,
  type SkillEvidenceRecord,
  type NodeSkillEvidenceFlags,
  type SkillEvidenceDimension,
} from "./repositories/opening-skill-evidence";


export * from "./schema/opening-teaching-activities";
export * from "./schema/opening-teaching-content";
export {
  createOpeningTeachingContentRepository,
  redactBlocksForClientInit,
  sameActivitySpecGraph,
  sanitizeCheckpointForRestore,
  type OpeningTeachingContentRepository,
} from "./repositories/opening-teaching-content";

export {
  createOpeningTeachingActivitiesRepository,
  assertOwnedActivity,
  ensureCourseContinueActivity,
  type OpeningTeachingActivitiesRepository,
} from "./repositories/opening-teaching-activities";
export { readOpeningTeachingTaskFocus, readOpeningTeachingCompilerFocus, type TeachingCompilerFocus } from "./repositories/opening-teaching-focus";

export {
  createOpeningTeachingCommandsRepository,
  sameCommandIntent,
  classifySkipSideEffects,
  type OpeningTeachingCommandsRepository,
} from "./repositories/opening-teaching-commands";

export { listDeliveredHelpByActivity } from "./repositories/opening-learning-help";
export { listObservationHeadsByActivity } from "./repositories/opening-learning-observations";

export * from "./schema/opening-action-digest-decisions";
export {
  createOpeningActionDigestDecisionsRepository,
  type OpeningActionDigestDecisionsRepository,
  type ActionCandidateStore,
  type RecordActionDigestDecisionInput,
  type ActionDigestDecisionStatus,
} from "./repositories/opening-action-digest-decisions";

export {
  exportOpeningBackup,
  publishOpeningBackupArchive,
  previewOpeningRestore,
  applyOpeningRestore,
  executeOpeningRestoreApply,
  createMemoryOpeningRestoreObjectPut,
  createOpeningS3RestoreObjectPut,
  parseOpeningRestoreObjectVersion,
  resolveOpeningRestoreCliLiveDeps,
  OpeningBackupExportError,
  assembleOpeningBackupDraft,
  prepareOpeningSourceBackup,
  readOpeningBackupRecords,
  OPENING_BACKUP_TABLES,
  OPENING_RESTORE_APPLY_ORDER,
  OPENING_RESTORE_ROW_COLUMNS,
  validateOpeningRestore,
  writeOpeningBackupArchive,
  encryptOpeningArchive,
  decryptOpeningArchive,
  snapshotOpeningBackupSources,
  verifyOpeningBackupObjects,
  createOpeningBackupReader,
  evaluateOpeningRestoreEmptyNamespace,
  readOpeningRestoreNamespaceCounts,
  isOpeningRestoreNeverTable,
  OPENING_RESTORE_NEVER_TABLES,
  type OpeningBackupRecordSnapshot,
  type OpeningBackupTable,
  type OpeningSourceStaging,
  type PublishOpeningBackupArchiveOptions,
  type OpeningRestoreApplyArgs,
  type OpeningRestoreApplyResult,
  type OpeningRestoreApplyGuarantees,
  type OpeningRestoreApplyPlan,
  type OpeningBackupSource,
  type OpeningRestoreNamespaceCounts,
  type OpeningRestoreEmptyNamespaceResult,
  type OpeningRestoreObjectPut,
  type OpeningRestoreObjectStorage,
  type OpeningRestoreExecuteArgs,
  type OpeningRestoreExecuteResult,
  type OpeningRestoreCliLiveDepsResult,
  type OpeningRestoreCliLiveDepsOk,
  type OpeningRestoreCliLiveDepsMissing,
  planOpeningRestoreApply,
} from "./repositories/opening-backup";
export { createOpeningTranscriptionCheckpointsRepository, type TranscriptionChunkIdentity, type TranscriptionChunkReceipt } from "./repositories/opening-transcription-checkpoints";

export { readOpeningLoopMetrics } from "./repositories/opening-loop-metrics";

export { proposeOpeningLocalPlan, type LocalPlanOptions, type LocalPlanAdditional } from "./repositories/opening-local-replan";

export * from "./repositories/opening-conversation-plan";
export * from "./repositories/opening-suggestion-feedback";

export * from "./schema/opening-suggestion-feedback";

export { acceptOpeningPlan } from "./repositories/opening-plan-accept";
export * from "./repositories/opening-coach-plans";

export * from "./repositories/opening-conversation-planning-context";

export * from "./schema/opening-measurement";
export { createOpeningMeasurementRepository, type OpeningMeasurementRepository } from "./repositories/opening-measurement";
export { openingJobScope, lockOpeningJobExecution, type OpeningJobScope } from "./repositories/opening-job-execution";

export * from "./schema/opening-exam-sprint";
export { createOpeningExamSprintRepository, OpeningExamSprintRepositoryError, type OpeningExamSprintRepository, type OpeningExamSprintExport } from "./repositories/opening-exam-sprint";
export * from "./schema/opening-exam-integration";
export { createOpeningExamIntegrationRepository } from "./repositories/opening-exam-integration";
export { createOpeningAiGradingRepository, type OpeningAiGradingContext } from "./repositories/opening-ai-grading";
export { createOpeningExamReviewsRepository } from "./repositories/opening-exam-reviews";
export * from "./schema/opening-exam-forecast";
export { createOpeningExamForecastRepository } from "./repositories/opening-exam-forecast";
export { readOpeningExamPublicSource } from "./repositories/opening-exam-public-source";

export * from "./repositories/opening-study-context";

export * from "./repositories/opening-learner-state-read";

export * from "./repositories/opening-learning-decisions";

export * from "./schema/opening-learning-decisions";

export * from "./repositories/opening-study-exposure";
export * from "./repositories/opening-study-intent-events";
export * from "./schema/opening-study-intent-events";

export * from "./repositories/opening-learner-shadow-predictions";

export * from "./repositories/opening-assistant-proposals";

export { lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./repositories/opening-learning-facts";

export * from "./repositories/opening-content-delivery";

export * from "./schema/opening-assistant-proposals";

export * from "./repositories/opening-teaching-hints";
export * from "./repositories/opening-today-courses";

export * from "./repositories/opening-span-session";
