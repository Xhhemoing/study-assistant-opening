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
  sourceChunkSchema,
  citationSchema,
  sourceCourseLinkInputSchema,
  sourceCourseUnlinkInputSchema,
  type SourceMime,
  type UploadInput,
  type SourceRecord,
  type UploadTicket,
  type SourceChunk,
  type Citation,
  type SourceCourseLinkInput,
  type SourceCourseUnlinkInput,
} from "./sources";

export {
  jobKindSchema,
  jobStatusSchema,
  jobRecordSchema,
  type JobKind,
  type JobStatus,
  type JobRecord,
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
  conversationCreateInputSchema,
  type TutorMode,
  type TurnInput,
  type ProviderInput,
  type ProviderOutput,
  type TurnRecord,
  type BudgetReservation,
  type EphemeralTurnInput,
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
} from "./learning";

export {
  weekSessionSchema,
  timeBlockSchema,
  taskItemSchema,
  taskCreateInputSchema,
  plannedBlockSchema,
  planDraftSchema,
  acceptPlanInputSchema,
  reminderSchema,
  timeConfigSchema,
  timeConfigSaveInputSchema,
  timeConfigSupportsAbsoluteScheduling,
  type WeekSession,
  type TimeBlock,
  type TaskItem,
  type TaskCreateInput,
  type PlannedBlock,
  type PlanDraft,
  type AcceptPlanInput,
  type Reminder,
  type TimeConfig,
  type TimeConfigSaveInput,
} from "./planning";

export { connectionKindSchema, connectionStateSchema, connectionViewSchema, imapSetupInputSchema, imapCursorSchema, connectionCredentialInputSchema, type ConnectionKind, type ConnectionState, type ConnectionView, type ImapSetupInput, type ImapCursor } from "./connections";
export { importIdentitySchema, importReceiptSchema, emailImportInputSchema, type ImportIdentity, type ImportReceipt, type EmailImportInput } from "./imports";
export { mediaMimeSchema, mediaUploadInputSchema, mediaSegmentSchema, type MediaSegment } from "./media";
export { knowledgeNodeSchema, knowledgeEdgeSchema, knowledgeSnapshotSchema, skillEvidenceSchema, tutorActionSchema, type KnowledgeNode, type KnowledgeEdge, type KnowledgeSnapshot, type SkillEvidence, type TutorAction } from "./knowledge";
export { actionCandidateSchema, actionDigestSchema, type ActionCandidate, type ActionDigest } from "./proactive";
