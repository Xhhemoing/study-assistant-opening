export const AI_CANDIDATE_ONLY = true as const;

export {
  createOpeningProvider,
  OpeningProviderError,
  type OpeningProviderOptions,
} from "./opening/provider";
export { classifyProviderFailure, type ProviderFailure } from "./opening/errors";
export {
  estimateUsage,
  extractUsage,
  usageFromOutput,
  type OpeningPricing,
  type OpeningUsage,
} from "./opening/usage";

export { ROLE_POLICIES, getRolePolicy, type RolePolicy } from "./roles";
export {
  AIProviderResponseValidationError,
  createProviderRequest,
  validateProviderResponse,
  type AIProvider,
  type AIProviderRequest,
} from "./providers/provider";

export { renderContext, selectContext, keywordOverlapScore } from "./opening/context";
export {
  DEFAULT_PICK_SOURCES_K,
  MIN_PICK_SOURCES_K,
  MAX_PICK_SOURCES_K,
  clampPickSourcesK,
  pickSourceIds,
  shouldAutoPickSources,
} from "./opening/pick-sources";
export { resolveCitations } from "./opening/citations";
export {
  assertEphemeralInput,
  canProposeTask,
  ConversationPolicyError,
  EPHEMERAL_HISTORY_MAX_CHARS,
  EPHEMERAL_HISTORY_MAX_TURNS,
  stripEphemeralCandidates,
} from "./opening/conversation-policy";

export { selectedOpeningModelId, resolveOpeningModel, openingModelSnapshot, OpeningModelRoutingError } from "./opening/model-routing";
export { mergeOpeningCatalog, resolveMergedDefaultModelId, type WorkspaceCatalogModel } from "./opening/catalog-merge";
export { resolveEffectiveDailyCap, OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS, type ResolveEffectiveDailyCapInput, type EffectiveDailyCap } from "./opening/effective-cap";
export {
  DEFAULT_BUDGET_TIME_ZONE,
  resolveBudgetTimeZone,
  resolveBudgetLocalDay,
  isInstantOnBudgetLocalDay,
  type BudgetLocalDay,
} from "./opening/budget-local-day";

export {
  AI_READINESS_SOFT_KEYS,
  aiReadinessSeverityForKey,
  buildAiReadinessItems,
  hasAiReadinessHardBlockers,
  isAiReadinessHardBlocker,
  type AiReadinessFacts,
  type AiReadinessItem,
  type AiReadinessSeverity,
} from "./opening/ai-readiness";

export {
  assembleTeachingEvidencePack,
  assertNoHeldOutLeak,
  classifyClaimSupport,
  formatProviderContext,
  type TeachingEvidencePack,
  type TeachingEvidenceDenylist,
  type AssembleTeachingEvidencePackInput,
} from "./opening/teaching-evidence";

export {
  proposeTeachingOutline,
  compileCurrentActivity,
  buildCompileProviderInput,
  projectClientSafeLibraryBlocks,
  createCompilerBuildPublishInput,
  isTeachingCompilerEnabled,
  type ProposeOutlineInput,
  type CompileCurrentInput,
  type CompileCurrentResult,
  type CompileLibraryBlock,
  type BuildCompilerPublishInputOptions,
} from "./opening/teaching-compiler";

export {
  verifyTeachingContent,
  verifyTutorTurnOutput,
  scanInjectionRisks,
  detectAuthoritySpoof,
  isTeachingValidationEnabled,
  createTeachingValidationAfterPublish,
  type VerifyTeachingInput,
  type VerifyTeachingKeyClaim,
  type VerifyTutorOutputInput,
  type TeachingValidationPromotion,
  type CreateTeachingValidationAfterPublishOptions,
} from "./opening/teaching-verifiers";

export {
  ANSWER_STYLE_BUDGETS,
  scoreAnswerStyle,
  summarizeAnswerStyle,
  type AnswerStyleScore,
  type AnswerStyleScoreInput,
  type AnswerStyleSummary,
} from "./opening/answer-style-eval";
export {
  ANSWER_STYLE_SAMPLES,
  type AnswerStyleCategory,
  type AnswerStyleSample,
} from "./opening/answer-style-samples";
