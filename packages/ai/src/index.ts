/**
 * AI orchestration package — providers and candidates only; never formal content writes.
 */
export const AI_CANDIDATE_ONLY = true as const;

export { ROLE_POLICIES, getRolePolicy, type RolePolicy } from "./roles";
export {
  AIProviderResponseValidationError,
  createProviderRequest,
  validateProviderResponse,
  type AIProvider,
  type AIProviderRequest,
} from "./providers/provider";
