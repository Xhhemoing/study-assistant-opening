export {
  DOCLING_PINNED_VERSION,
  uuidSchema,
  isoDateTimeSchema,
  calendarDateSchema,
  sha256HexSchema,
  scopeSchema,
  apiFailureSchema,
  type Scope,
  type ApiFailure,
} from "./foundation";

export {
  sourceMimeSchema,
  uploadInputSchema,
  sourceRecordSchema,
  uploadTicketSchema,
  sourceDownloadSchema,
  sourceChunkSchema,
  citationSchema,
  sourceCourseLinkInputSchema,
  sourceCourseUnlinkInputSchema,
  sourceActionInputSchema,
  sourceImpactSchema,
  sourceActionResultSchema,
  sourceDeletionListSchema,
  type SourceActionInput,
  type SourceImpact,
  type SourceActionResult,
  type SourceDeletion,
  type SourceMime,
  type UploadInput,
  type SourceRecord,
  type UploadTicket,
  type SourceDownload,
  type SourceChunk,
  type Citation,
  type SourceCourseLinkInput,
  type SourceCourseUnlinkInput,
} from "./sources";

export { snippetCreateInputSchema, snippetCreateResponseSchema, type SnippetCreateInput, type SnippetCreateResponse } from "./snippets";

export {
  jobKindSchema,
  jobStatusSchema,
  jobRecordSchema,
  jobStatusResponseSchema,
  tutorJobErrorSchema,
  tutorMetadataJobPayloadSchema,
  type JobKind,
  type JobStatus,
  type JobRecord,
  type JobStatusResponse,
  type TutorJobError,
} from "./jobs";

export {
  tutorModeSchema,
  turnInputSchema,
  providerMediaCapabilitySchema,
  providerImagePartSchema,
  providerInputSchema,
  assistantCandidateSchema,
  assistantCandidateRecordSchema,
  providerOutputSchema,
  turnRecordSchema,
  turnStatusSchema,
  TERMINAL_TURN_STATUSES,
  terminalTurnStatusForJobError,
  type TurnStatus,
  budgetReservationSchema,
  ephemeralTurnInputSchema,
  ephemeralTurnResponseSchema,
  conversationCreateInputSchema,
  type TutorMode,
  type TurnInput,
  type ProviderInput,
  type ProviderOutput,
  type TurnRecord,
  type BudgetReservation,
  type EphemeralTurnInput,
  type EphemeralTurnResponse,
  type AssistantCandidate,
  type AssistantCandidateRecord,
  type ConversationCreateInput,
} from "./tutor";

export {
  conversationSummarySchema,
  providerHistoryMessageSchema,
  conversationResumeSchema,
  type ConversationSummary,
  type ConversationResume,
} from "./conversations";

export {
  memoryItemSchema,
  memoryDecisionSchema,
  memoryEffectiveScope,
  memoryVisibleInCourseScope,
  type MemoryItem,
  type MemoryDecision,
  type MemoryEffectiveScope,
} from "./memory";

export {
  candidateRefSchema,
  reviewResultSchema,
  type CandidateRef,
  type ReviewResult,
} from "./candidate-review";

export {
  memoryCandidateDecisionSchema,
  type MemoryCandidateDecision,
} from "./memory-candidate";

export {
  observationOutcomeSchema,
  assistanceLevelSchema,
  learningEvidenceVerdictSchema,
  ASSISTANCE_BLOCKS_INDEPENDENT,
  canBecomeObservedIndependent,
  shouldCreateLearningSession,
  observationAllowsIndependent,
  problemRefSchema,
  helpExposureKindSchema,
  helpExposureSchema,
  observationInputSchema,
  activityScopedObservationInputSchema,
  learningObservationSchema,
  learningSummarySchema,
  retestCandidateSchema,
  learningSessionCreateInputSchema,
  type ObservationInput,
  type LearningObservation,
  type LearningSummary,
  type RetestCandidate,
  type LearningEvidenceVerdict,
  type LearningSessionCreateInput,
  type ProblemRef,
  type HelpExposureKind,
  type HelpExposure,
  type ActivityScopedObservationInput,
  verdictSourceSchema,
} from "./learning";

export {
  weekSessionSchema,
  timeBlockSchema,
  taskItemSchema,
  taskRetestProjectionSchema,
  taskCreateInputSchema,
  taskCreateResultSchema,
  plannedBlockSchema,
  planDraftSchema,
  acceptPlanInputSchema,
  planAcceptConflictReasonSchema,
  reminderSchema,
  reminderListSchema,
  reminderEnqueueInputSchema,
  timeConfigSchema,
  timeConfigSaveInputSchema,
  timeConfigSupportsAbsoluteScheduling,
  type WeekSession,
  type TimeBlock,
  type TaskItem,
  type TaskRetestProjection,
  type TaskCreateInput,
  type TaskCreateResult,
  taskStatusUpdateInputSchema,
  type TaskStatusUpdateInput,
  taskOriginSchema,
  taskDeferInputSchema,
  type TaskOrigin,
  type TaskDeferInput,
  planReasonCodeSchema,
  planBlockReasonSchema,
  suggestionKindSchema,
  suggestedTaskSchema,
  planDraftOriginSchema,
  planUndoInputSchema,
  type PlanReasonCode,
  type PlanBlockReason,
  type SuggestionKind,
  type SuggestedTask,
  type PlanDraftOrigin,
  type PlanUndoInput,
  type PlannedBlock,
  type PlanDraft,
  type AcceptPlanInput,
  type PlanAcceptConflictReason,
  type Reminder,
  type ReminderList,
  type ReminderEnqueueInput,
  type TimeConfig,
  type TimeConfigSaveInput,
} from "./planning";

export { connectionKindSchema, connectionStateSchema, connectionViewSchema, imapSetupInputSchema, imapCursorSchema, connectionCredentialInputSchema, type ConnectionKind, type ConnectionState, type ConnectionView, type ImapSetupInput, type ImapCursor } from "./connections";
export { importIdentitySchema, importReceiptSchema, emailImportInputSchema, type ImportIdentity, type ImportReceipt, type EmailImportInput } from "./imports";
export {
  mediaMimeSchema,
  mediaUploadInputSchema,
  mediaSegmentSchema,
  mediaSegmentCorrectionInputSchema,
  mediaSegmentsResponseSchema,
  mediaSegmentCorrectionResultSchema,
  type MediaSegment,
  type MediaSegmentCorrectionInput,
  type MediaSegmentsResponse,
  type MediaSegmentCorrectionResult,
} from "./media";
export { knowledgeNodeSchema, knowledgeEdgeSchema, knowledgeSnapshotSchema, skillEvidenceSchema, tutorActionSchema, type KnowledgeNode, type KnowledgeEdge, type KnowledgeSnapshot, type SkillEvidence, type TutorAction } from "./knowledge";
export { actionCandidateSchema, actionDigestSchema, type ActionCandidate, type ActionDigest } from "./proactive";

export * from "./learning-evidence";
export * from "./learning-attempts";
export * from "./learning-revisions";
export {
  retestActivityResultSchema,
  retestActivitySchema,
  retestActivityStatusSchema,
  retestActivityTimesSchema,
  type RetestActivity,
  type RetestActivityResult,
  type RetestActivityStatus,
  type RetestActivityTimes,
} from "./retest-activity";

export * from "./ai-settings";
export * from "./system-query";
export * from "./planning-settings";
export * from "./plan-feedback";
export { taskFeedbackInputSchema, taskFeedbackReasonSchema, type TaskFeedbackInput } from "./planning-tasks";
export * from "./sprint-budget";
export * from "./adaptive-planning";
export * from "./goal-learning";
export * from "./intervention-prefs";
export * from "./model-providers";
export * from "./learning-history";
export * from "./learning-summary-page";
export * from "./teaching-activity";
export * from "./teaching-content";
export * from "./teaching-commands";
export * from "./teaching-resume";
export * from "./teaching-math-model";

export * from "./matrix-evaluation";
export * from "./ai-evaluation";
export * from "./loop-metrics";
export * from "./learning-experience";

export * from "./local-replan";

export * from "./conversation-plan";

export * from "./coach-plans";
export * from "./suggestion-feedback";

export * from "./conversation-planning-context";

export * from "./measurement";

export * from "./span-learning";
export * from "./span-hints";

export * from "./composer-purpose";
export * from "./study-session-intent";

export * from "./assistant-proposals";

export { studyContextAnchorSchema, studyExposureReceiptSchema, type StudyContextAnchor, type StudyExposureReceipt } from "./tutor";
export * from "./material-retrieval-evaluation";

export * from "./span-session";

export { firstLearningInputSchema, type FirstLearningInput } from "./first-learning";

export * from "./tutor-learner-context";
