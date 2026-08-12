import { z } from "zod";

export * from "./promotions";
export * from "./revision-proposal";

export {
  workspaceIdSchema,
  workspaceSchema,
  type WorkspaceId,
  type Workspace,
} from "./workspace";

export {
  assetTypeSchema,
  assetLifecycleSchema,
  assetSchema,
  canTransitionLifecycle,
  assertLifecycleTransition,
  LifecycleTransitionError,
  type AssetType,
  type AssetLifecycle,
  type Asset,
} from "./assets";

export {
  registerRequestSchema,
  loginRequestSchema,
  authUserSchema,
  authErrorSchema,
  type RegisterRequest,
  type LoginRequest,
  type AuthUser,
  type AuthErrorBody,
} from "./auth";

export {
  workspaceDefaultEntrySchema,
  workspacePreferenceUpdateSchema,
  workspacePreferenceResponseSchema,
  type WorkspaceDefaultEntry,
  type WorkspacePreferenceUpdate,
  type WorkspacePreferenceResponse,
} from "./workspace-preferences";

export {
  scenarioPresetSchema,
  studyGoalSchema,
  studyGoalInputSchema,
  type ScenarioPreset,
  type StudyGoal,
  type StudyGoalInput,
} from "./goals";

export {
  abilitySliceSchema,
  practiceItemKindSchema,
  practiceItemSchema,
  errorCauseSchema,
  attemptEventSchema,
  type AbilitySlice,
  type PracticeItemKind,
  type PracticeItem,
  type ErrorCause,
  type AttemptEvent,
} from "./attempts";

export {
  statusWordSchema,
  summaryMetricSchema,
  recommendedActionSchema,
  statusResultSchema,
  type StatusWord,
  type SummaryMetric,
  type RecommendedAction,
  type StatusResult,
} from "./assessment";

export {
  plannedTaskKindSchema,
  plannedTaskSchema,
  planOptionSchema,
  todayPlanSchema,
  type PlannedTaskKind,
  type PlannedTask,
  type PlanOption,
  type TodayPlan,
} from "./plan";

export {
  reviewGradeSchema,
  reviewCardSchema,
  reviewStateSchema,
  type ReviewGrade,
  type ReviewCard,
  type ReviewState,
} from "./srs";

export {
  aiRoleSchema,
  explorationSchema,
  persistedExplorationSchema,
  explorationStatusSchema,
  explorationBlockKindSchema,
  explorationBranchSchema,
  explorationBlockSchema,
  createExplorationRequestSchema,
  createExplorationBranchRequestSchema,
  createExplorationBlockRequestSchema,
  explorationStatusRequestSchema,
  explorationListResponseSchema,
  explorationDetailResponseSchema,
  explorationCreateResponseSchema,
  explorationBranchResponseSchema,
  explorationBlockResponseSchema,
  explorationStatusResponseSchema,
  chatTurnSchema,
  promotionCandidateSchema,
  type AIRole,
  type Exploration,
  type PersistedExploration,
  type ExplorationBranch,
  type ExplorationBlock,
  type CreateExplorationRequest,
  type CreateExplorationBranchRequest,
  type CreateExplorationBlockRequest,
  type ExplorationStatus,
  type ExplorationBlockKind,
  type ExplorationListResponse,
  type ExplorationDetailResponse,
  type ExplorationCreateResponse,
  type ExplorationBranchResponse,
  type ExplorationBlockResponse,
  type ExplorationStatusResponse,
  type ChatTurn,
  type PromotionCandidate,
} from "./exploration";

export { diagnosticsSchema, type Diagnostics } from "./diagnostics";

export {
  aiCandidateSchema,
  rolePolicySchema,
  aiConversationJobRequestSchema,
  aiProviderResponseSchema,
  aiJobProvenanceSchema,
  aiConversationJobResultSchema,
  type AICandidate,
  type RolePolicy,
  type AIConversationJobRequest,
  type AIProviderResponse,
  type AIJobProvenance,
  type AIConversationJobResult,
} from "./ai-jobs";

export {
  searchableDocumentSchema,
  searchableDocumentsResponseSchema,
  type SearchableDocument,
} from "./search";

export {
  searchRequestSchema,
  searchHitSchema,
  searchResponseSchema,
  type SearchHit,
  type SearchRequest,
  type SearchResponse,
} from "./search";

export {
  documentTagSchema,
  documentTagsSchema,
  documentTagsResponseSchema,
  documentTagsUpdateSchema,
  normalizeDocumentTags,
  type DocumentTags,
  type DocumentTagsUpdate,
} from "./tags";

export {
  requirementProfileKindSchema,
  assessmentModeSchema,
  abilityDimensions,
  abilityWeightsSchema,
  courseRequirementProfileSchema,
  courseRequirementInputSchema,
  type RequirementProfileKind,
  type AssessmentMode,
  type AbilityDimension,
  type AbilityWeights,
  type CourseRequirementProfile,
  type CourseRequirementInput,
} from "./course-requirements";

export {
  propertyValueTypeSchema,
  readOnlyPropertySchema,
  blockPropertyGroupSchema,
  documentPropertiesResponseSchema,
  type ReadOnlyProperty,
  type BlockPropertyGroup,
  type DocumentPropertiesResponse,
} from "./properties";

export {
  relationTypeSchema,
  relationEndpointSchema,
  knowledgeLinkSchema,
  knowledgeLinksResponseSchema,
  indexDocumentLinksRequestSchema,
  relationMutationTargetSchema,
  createDocumentRelationRequestSchema,
  updateDocumentRelationRequestSchema,
  managedRelationSchema,
  managedRelationsResponseSchema,
  type RelationType,
  type RelationEndpoint,
  type KnowledgeLink,
  type KnowledgeLinksResponse,
  type IndexDocumentLinksRequest,
  type RelationMutationTarget,
  type CreateDocumentRelationRequest,
  type UpdateDocumentRelationRequest,
  type ManagedRelation,
  type ManagedRelationsResponse,
} from "./relations";

export const dependencyStatusSchema = z.object({
  status: z.enum(["up", "down"]),
  latencyMs: z.number().nonnegative().optional(),
  errorCode: z.string().optional(),
});

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  service: z.string().min(1),
  checks: z.object({
    database: dependencyStatusSchema,
    redis: dependencyStatusSchema,
    storage: dependencyStatusSchema,
  }),
});

export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const workerSmokeJobSchema = z.object({
  kind: z.literal("smoke"),
  message: z.string().min(1),
});

export type WorkerSmokeJob = z.infer<typeof workerSmokeJobSchema>;
