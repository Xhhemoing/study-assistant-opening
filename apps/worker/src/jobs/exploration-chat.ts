import {
  aiConversationJobRequestSchema,
  aiConversationJobResultSchema,
  type AIConversationJobRequest,
  type AIConversationJobResult,
} from "@aistudy/contracts";
import { createProviderRequest, getRolePolicy, validateProviderResponse, type AIProvider } from "@aistudy/ai";

export async function processExplorationChatJob(
  input: AIConversationJobRequest,
  provider: AIProvider,
  clock: () => Date = () => new Date(),
): Promise<AIConversationJobResult> {
  const job = aiConversationJobRequestSchema.parse(input);
  const startedAt = clock().toISOString();
  let text = "";
  let candidates: AIConversationJobResult["candidates"] = [];
  let providerRequestStatus: "completed" | "not_called" = "not_called";
  let requestId: string | null = null;
  let costUsd: number | null = null;
  if (job.role !== "silent") {
    const response = validateProviderResponse(await provider.complete(createProviderRequest(job)));
    providerRequestStatus = "completed";
    text = response.text;
    candidates = getRolePolicy(job.role).allowCandidateProposal ? response.candidates : [];
    requestId = response.requestId ?? null;
    costUsd = response.costUsd ?? null;
  }
  const result = {
    jobId: job.jobId,
    explorationId: job.explorationId,
    role: job.role,
    reply: text,
    candidates,
    provenance: {
      provider: job.provider,
      model: job.model,
      promptPolicyVersion: job.promptPolicyVersion,
      selectedSourceIds: [...job.selectedSourceIds],
      providerRequestStatus,
      requestId,
      costUsd,
      startedAt,
      completedAt: clock().toISOString(),
    },
    writeMode: "candidate_only" as const,
  };
  return aiConversationJobResultSchema.parse(result);
}
