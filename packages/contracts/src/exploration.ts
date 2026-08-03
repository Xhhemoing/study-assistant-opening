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

export const explorationSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  title: z.string().min(1).max(120),
  status: z.enum(["open", "closed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

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
export type ChatTurn = z.infer<typeof chatTurnSchema>;
export type PromotionCandidate = z.infer<typeof promotionCandidateSchema>;
