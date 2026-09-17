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
