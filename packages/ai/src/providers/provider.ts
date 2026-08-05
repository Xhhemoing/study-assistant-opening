import {
  aiConversationJobRequestSchema,
  aiProviderResponseSchema,
  type AIConversationJobRequest,
  type AIProviderResponse,
} from "@aistudy/contracts";
import { getRolePolicy } from "../roles";

export type AIProviderRequest = {
  role: AIConversationJobRequest["role"];
  instruction: string;
  input: string;
  selectedSourceIds: string[];
};

export interface AIProvider {
  complete(request: AIProviderRequest): Promise<unknown>;
}

export function createProviderRequest(job: AIConversationJobRequest): AIProviderRequest {
  const parsed = aiConversationJobRequestSchema.parse(job);
  const policy = getRolePolicy(parsed.role);
  return {
    role: parsed.role,
    instruction: policy.instruction,
    input: parsed.input,
    selectedSourceIds: policy.allowSourceRetrieval ? [...parsed.selectedSourceIds] : [],
  };
}

export class AIProviderResponseValidationError extends Error {
  constructor(cause: unknown) {
    super("AIProviderResponseValidationError");
    this.name = "AIProviderResponseValidationError";
    this.cause = cause;
  }
  declare readonly cause: unknown;
}

export function validateProviderResponse(value: unknown): AIProviderResponse {
  const result = aiProviderResponseSchema.safeParse(value);
  if (!result.success) throw new AIProviderResponseValidationError(result.error);
  return result.data;
}
