import { z } from "zod";

export const aiRoleSchema = z.enum([
  "retriever",
  "explainer",
  "tutor",
  "challenger",
  "editor",
  "examiner",
  "collaborator",
  "silent",
]);

export const explorationStatusSchema = z.enum(["open", "closed"]);
export const explorationBlockKindSchema = z.enum(["scratch", "hypothesis", "open_question"]);

const explorationCoreSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  status: explorationStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** Kept backward-compatible for the existing simulated Explore provider. */
export const explorationSchema = explorationCoreSchema.extend({
  workspaceId: z.string().uuid().optional(),
  courseId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  closedAt: z.string().datetime().nullable().optional(),
});

export const persistedExplorationSchema = explorationCoreSchema.extend({
  workspaceId: z.string().uuid(),
  courseId: z.string().uuid().nullable(),
  goalId: z.string().uuid().nullable(),
  closedAt: z.string().datetime().nullable(),
});

export const explorationBranchSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  explorationId: z.string().uuid(),
  parentBranchId: z.string().uuid().nullable(),
  title: z.string().trim().min(1).max(120),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const explorationBlockSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  explorationId: z.string().uuid(),
  branchId: z.string().uuid(),
  kind: explorationBlockKindSchema,
  content: z.string().trim().min(1).max(20_000),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createExplorationRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  courseId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
});

export const createExplorationBranchRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  parentBranchId: z.string().uuid().nullable().optional(),
});

export const createExplorationBlockRequestSchema = z.object({
  branchId: z.string().uuid(),
  kind: explorationBlockKindSchema,
  content: z.string().trim().min(1).max(20_000),
  position: z.number().int().nonnegative().optional(),
});

export const explorationStatusRequestSchema = z.object({
  status: explorationStatusSchema,
});

export const explorationListResponseSchema = z.object({
  explorations: z.array(persistedExplorationSchema),
});

export const explorationDetailResponseSchema = z.object({
  exploration: persistedExplorationSchema,
  branches: z.array(explorationBranchSchema),
  blocks: z.array(explorationBlockSchema),
});

export const explorationCreateResponseSchema = z.object({
  exploration: persistedExplorationSchema.extend({
    rootBranch: explorationBranchSchema,
  }),
});

export const explorationBranchResponseSchema = z.object({ branch: explorationBranchSchema });
export const explorationBlockResponseSchema = z.object({ block: explorationBlockSchema });
export const explorationStatusResponseSchema = z.object({ exploration: persistedExplorationSchema });

export const chatTurnSchema = z.object({
  id: z.string().uuid(),
  explorationId: z.string().uuid(),
  author: z.enum(["user", "ai"]),
  aiRole: aiRoleSchema.nullable(),
  content: z.string().min(1),
  simulated: z.boolean(),
  createdAt: z.string().datetime(),
});

export const promotionCandidateSchema = z.object({
  id: z.string().uuid(),
  explorationId: z.string().uuid(),
  turnId: z.string().uuid(),
  kind: z.enum(["note", "card", "question", "task"]),
  title: z.string().min(1),
  body: z.string().min(1),
  status: z.enum(["pending", "promoted", "rejected"]),
  promotedTargetId: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export type AIRole = z.infer<typeof aiRoleSchema>;
export type Exploration = z.infer<typeof explorationSchema>;
export type PersistedExploration = z.infer<typeof persistedExplorationSchema>;
export type ExplorationBranch = z.infer<typeof explorationBranchSchema>;
export type ExplorationBlock = z.infer<typeof explorationBlockSchema>;
export type CreateExplorationRequest = z.infer<typeof createExplorationRequestSchema>;
export type CreateExplorationBranchRequest = z.infer<typeof createExplorationBranchRequestSchema>;
export type CreateExplorationBlockRequest = z.infer<typeof createExplorationBlockRequestSchema>;
export type ExplorationStatus = z.infer<typeof explorationStatusSchema>;
export type ExplorationBlockKind = z.infer<typeof explorationBlockKindSchema>;
export type ExplorationListResponse = z.infer<typeof explorationListResponseSchema>;
export type ExplorationDetailResponse = z.infer<typeof explorationDetailResponseSchema>;
export type ExplorationCreateResponse = z.infer<typeof explorationCreateResponseSchema>;
export type ExplorationBranchResponse = z.infer<typeof explorationBranchResponseSchema>;
export type ExplorationBlockResponse = z.infer<typeof explorationBlockResponseSchema>;
export type ExplorationStatusResponse = z.infer<typeof explorationStatusResponseSchema>;
export type ChatTurn = z.infer<typeof chatTurnSchema>;
export type PromotionCandidate = z.infer<typeof promotionCandidateSchema>;
