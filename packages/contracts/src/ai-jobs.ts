import { z } from "zod";
import { aiRoleSchema } from "./exploration";

export const aiCandidateSchema = z.object({
  kind: z.enum(["note", "card", "question", "task"]),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

export const rolePolicySchema = z.object({
  role: aiRoleSchema,
  instruction: z.string().trim().min(1),
  allowSourceRetrieval: z.boolean(),
  allowCandidateProposal: z.boolean(),
  allowFormalAssetMutation: z.literal(false),
});

export const aiConversationJobRequestSchema = z.object({
  jobId: z.string().uuid(),
  explorationId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  role: aiRoleSchema,
  input: z.string().trim().min(1),
  selectedSourceIds: z.array(z.string().min(1)),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  promptPolicyVersion: z.string().trim().min(1),
});

export const aiProviderResponseSchema = z.object({
  text: z.string(),
  candidates: z.array(aiCandidateSchema),
  requestId: z.string().min(1).optional(),
  costUsd: z.number().nonnegative().optional(),
});

export const aiJobProvenanceSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  promptPolicyVersion: z.string().min(1),
  selectedSourceIds: z.array(z.string().min(1)),
  providerRequestStatus: z.enum(["completed", "not_called"]),
  requestId: z.string().min(1).nullable(),
  costUsd: z.number().nonnegative().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
});

export const aiConversationJobResultSchema = z.object({
  jobId: z.string().uuid(),
  explorationId: z.string().uuid(),
  role: aiRoleSchema,
  reply: z.string(),
  candidates: z.array(aiCandidateSchema),
  provenance: aiJobProvenanceSchema,
  writeMode: z.literal("candidate_only"),
});

export type AICandidate = z.infer<typeof aiCandidateSchema>;
export type RolePolicy = z.infer<typeof rolePolicySchema>;
export type AIConversationJobRequest = z.infer<typeof aiConversationJobRequestSchema>;
export type AIProviderResponse = z.infer<typeof aiProviderResponseSchema>;
export type AIJobProvenance = z.infer<typeof aiJobProvenanceSchema>;
export type AIConversationJobResult = z.infer<typeof aiConversationJobResultSchema>;
