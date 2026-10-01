export {
  DOCLING_PINNED_VERSION,
  uuidSchema,
  isoDateTimeSchema,
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
  type JobKind,
  type JobStatus,
  type JobRecord,
  type JobStatusResponse,
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
  helpExposureSchema,
  observationInputSchema,
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
  type HelpExposure,
  verdictSourceSchema,
} from "./learning";

export {
  weekSessionSchema,
  timeBlockSchema,
  taskItemSchema,
  taskCreateInputSchema,
  taskCreateResultSchema,
  plannedBlockSchema,
  planDraftSchema,
  acceptPlanInputSchema,
  reminderSchema,
  reminderListSchema,
  reminderEnqueueInputSchema,
  timeConfigSchema,
  timeConfigSaveInputSchema,
  timeConfigSupportsAbsoluteScheduling,
  type WeekSession,
  type TimeBlock,
  type TaskItem,
  type TaskCreateInput,
  type TaskCreateResult,
  taskStatusUpdateInputSchema,
  type TaskStatusUpdateInput,
  type PlannedBlock,
  type PlanDraft,
  type AcceptPlanInput,
  type Reminder,
  type ReminderList,
  type ReminderEnqueueInput,
  type TimeConfig,
  type TimeConfigSaveInput,
} from "./planning";

export { connectionKindSchema, connectionStateSchema, connectionViewSchema, imapSetupInputSchema, imapCursorSchema, connectionCredentialInputSchema, type ConnectionKind, type ConnectionState, type ConnectionView, type ImapSetupInput, type ImapCursor } from "./connections";
export { importIdentitySchema, importReceiptSchema, emailImportInputSchema, type ImportIdentity, type ImportReceipt, type EmailImportInput } from "./imports";
export { mediaMimeSchema, mediaUploadInputSchema, mediaSegmentSchema, type MediaSegment } from "./media";
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
export * from "./learning-history";
export * from "./learning-summary-page";
