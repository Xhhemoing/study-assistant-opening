import { z } from "zod";
import { learningEventSchema } from "./learning-events";
import { courseExamProposalSchema } from "./opening/course-exam";
import { teachingActivitySchema } from "./opening/teaching-activity";
import { activitySpecClientInitSchema } from "./opening/teaching-content";
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

/** Whether the review also became a learning fact (the SRS review itself always saves). */
export const cardReviewEvidenceSchema = z.enum([
  "recorded", "skipped_no_course", "skipped_course_archived", "skipped_source_unavailable", "skipped_unknown",
]);
export const gradeReviewResponseSchema = z.object({
  state: reviewStateSchema,
  event: learningEventSchema,
  evidence: cardReviewEvidenceSchema.optional(),
});

export const createCardRequestSchema = z.object({
  cardId: z.string().uuid().optional(),
  front: z.string().min(1),
  back: z.string().min(1),
  sourceDocumentId: z.string().uuid().nullable().optional(),
  syllabusPointId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
  reviewKind: z.enum(["question", "concept"]).optional(),
  courseId: z.string().uuid().nullable().optional(),
  observationId: z.string().uuid().optional(),
  skillLabel: z.string().trim().min(1).max(200).nullable().optional(),
});

/** An observation-backed wrong-answer card always needs a new question. */
export function cardReviewKind(card: { originObservationRootId?: string | null; tags: readonly string[] }): "question" | "concept" | null {
  if (card.originObservationRootId || card.tags.includes("review:question") || card.tags.includes("错题")) return "question";
  return card.tags.includes("review:concept") ? "concept" : null;
}

export const cardVariantProposalSchema = courseExamProposalSchema.shape.questions.element.omit({ evidenceChunkIds: true, topic: true });
export type CardVariantProposal = z.infer<typeof cardVariantProposalSchema>;

export const cardVariantRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("retry") }).strict(),
  z.object({ action: z.literal("complete"), observationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("classify"), reviewKind: z.enum(["question", "concept"]) }).strict(),
]);
export const cardVariantReviewSchema = z.object({ activity: teachingActivitySchema, clientInit: activitySpecClientInitSchema.nullable() }).strict();
export type CardVariantReview = z.infer<typeof cardVariantReviewSchema>;

/** Editable suggestions from a submitted, current incorrect observation. No card is created here. */
export const observationCardDraftSchema = z.object({
  observationId: z.string().uuid(),
  front: z.string().max(4000),
  back: z.string().max(4000),
  courseId: z.string().uuid(),
  skillLabel: z.string().min(1).max(200),
});
export type ObservationCardDraft = z.infer<typeof observationCardDraftSchema>;

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
