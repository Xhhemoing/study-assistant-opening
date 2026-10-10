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

export { renderContext, selectContext } from "./opening/context";
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
