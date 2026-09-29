import {
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

/** Maps a job already validated and normalized at the worker boundary. */
export function createProviderRequest(job: AIConversationJobRequest): AIProviderRequest {
  const policy = getRolePolicy(job.role);
  return {
    role: job.role,
    instruction: policy.instruction,
    input: job.input,
    selectedSourceIds: policy.allowSourceRetrieval ? [...job.selectedSourceIds] : [],
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
