import { z } from "zod";
import { learningEventSchema } from "./learning-events";
import {
  reviewCardSchema,
  reviewGradeSchema,
  reviewQueueModeSchema,
  reviewStateSchema,
} from "./srs";

export const gradeReviewRequestSchema = z.object({
  cardId: z.string().uuid(),
  grade: reviewGradeSchema,
  assisted: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(200),
  occurredAt: z.string().datetime().optional(),
});

export const gradeReviewResponseSchema = z.object({
  state: reviewStateSchema,
  event: learningEventSchema,
});

export const createCardRequestSchema = z.object({
  cardId: z.string().uuid().optional(),
  front: z.string().min(1),
  back: z.string().min(1),
  sourceDocumentId: z.string().uuid().nullable().optional(),
  syllabusPointId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
});

export const createCardResponseSchema = z.object({
  card: reviewCardSchema,
});

export const listReviewQueueQuerySchema = z.object({
  mode: reviewQueueModeSchema.default("auto"),
});

export const reviewQueueItemSchema = z.object({
  card: reviewCardSchema,
  state: reviewStateSchema,
  goalPriority: z.number().int(),
});

export const listReviewQueueResponseSchema = z.object({
  items: z.array(reviewQueueItemSchema),
});

const yyyyMmDd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "maintainUntil must be YYYY-MM-DD");

export const updateCardControlsRequestSchema = z
  .object({
    cardId: z.string().uuid(),
    archived: z.boolean().optional(),
    pausedUntil: z.string().datetime().nullable().optional(),
    maintainUntil: yyyyMmDd.nullable().optional(),
    excludeFromAssessment: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.archived !== undefined
      || value.pausedUntil !== undefined
      || value.maintainUntil !== undefined
      || value.excludeFromAssessment !== undefined,
    { message: "At least one card control field is required" },
  );

export type GradeReviewRequest = z.infer<typeof gradeReviewRequestSchema>;
export type GradeReviewResponse = z.infer<typeof gradeReviewResponseSchema>;
export type CreateCardRequest = z.infer<typeof createCardRequestSchema>;
export type CreateCardResponse = z.infer<typeof createCardResponseSchema>;
export type ListReviewQueueQuery = z.infer<typeof listReviewQueueQuerySchema>;
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;
export type ListReviewQueueResponse = z.infer<typeof listReviewQueueResponseSchema>;
export type UpdateCardControlsRequest = z.infer<typeof updateCardControlsRequestSchema>;
