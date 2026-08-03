import { z } from "zod";

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
  chatTurnSchema,
  promotionCandidateSchema,
  type AIRole,
  type Exploration,
  type ChatTurn,
  type PromotionCandidate,
} from "./exploration";

export { diagnosticsSchema, type Diagnostics } from "./diagnostics";

export {
  searchableDocumentSchema,
  searchableDocumentsResponseSchema,
  type SearchableDocument,
} from "./search";

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
