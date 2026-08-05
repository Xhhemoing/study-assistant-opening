import { z } from "zod";
export const promotionCandidateKindSchema = z.enum([
  "note",
  "card",
  "question",
  "task",
]);
export const promotionStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
]);
export const promotionTargetTypeSchema = z.enum([
  "document",
  "card",
  "question",
  "task",
]);
export const createPromotionRequestSchema = z
  .object({
    kind: promotionCandidateKindSchema,
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
    sourceTurnId: z.uuid().nullable().optional(),
  })
  .strict();
export const promotionRecordSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  explorationId: z.uuid(),
  sourceTurnId: z.uuid().nullable(),
  kind: promotionCandidateKindSchema,
  title: z.string(),
  body: z.string(),
  status: promotionStatusSchema,
  targetType: promotionTargetTypeSchema.nullable(),
  targetId: z.uuid().nullable(),
  reviewedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export const promotionResponseSchema = z.object({
  promotion: promotionRecordSchema,
});
export const promotionsResponseSchema = z.object({
  promotions: z.array(promotionRecordSchema),
});
export type PromotionCandidateKind = z.infer<
  typeof promotionCandidateKindSchema
>;
export type PromotionStatus = z.infer<typeof promotionStatusSchema>;
export type PromotionTargetType = z.infer<typeof promotionTargetTypeSchema>;
export type CreatePromotionRequest = z.infer<
  typeof createPromotionRequestSchema
>;
export type PromotionRecord = z.infer<typeof promotionRecordSchema>;
