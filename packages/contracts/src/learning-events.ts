import { z } from "zod";
import { abilitySliceSchema, errorCauseSchema } from "./attempts";
import { statusWordSchema } from "./assessment";
import { reviewGradeSchema } from "./srs";

export const LEARNING_EVENT_SCHEMA_VERSION = 1;

export const learningEventTypeSchema = z.enum(["attempt", "review", "correction"]);
export type LearningEventType = z.infer<typeof learningEventTypeSchema>;

export const attemptLearningPayloadSchema = z.object({
  answer: z.string(),
  correct: z.boolean(),
  assisted: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  hintCount: z.number().int().nonnegative(),
  confidence: z.number().int().min(1).max(5),
  errorCause: errorCauseSchema.nullable(),
  abilitySlice: abilitySliceSchema,
});

export const reviewLearningPayloadSchema = z.object({
  grade: reviewGradeSchema,
  /** Whether the learner actually received help during this review. */
  assisted: z.boolean(),
  /** Card-level opt-out: the result stays recorded but must not feed assessment. */
  excludeFromAssessment: z.boolean().default(false),
});

export const correctionLearningPayloadSchema = z.object({
  kind: z.enum(["error_cause", "status", "content_flag"]),
  note: z.string().trim().min(1).max(500),
  overrideStatus: statusWordSchema.nullable().optional(),
  overrideErrorCause: errorCauseSchema.nullable().optional(),
});

const envelopeBase = {
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  schemaVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(200),
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
};

export const learningEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelopeBase,
    type: z.literal("attempt"),
    contentId: z.string().uuid(),
    contentVersion: z.number().int().positive(),
    syllabusPointId: z.string().uuid(),
    correctsEventId: z.null(),
    payload: attemptLearningPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal("review"),
    contentId: z.string().uuid(),
    contentVersion: z.number().int().positive(),
    syllabusPointId: z.string().uuid().nullable(),
    correctsEventId: z.null(),
    payload: reviewLearningPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal("correction"),
    contentId: z.string().uuid().nullable(),
    contentVersion: z.number().int().positive().nullable(),
    syllabusPointId: z.string().uuid().nullable(),
    correctsEventId: z.string().uuid(),
    payload: correctionLearningPayloadSchema,
  }),
]);

const appendBase = {
  workspaceId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  schemaVersion: z.number().int().positive().default(LEARNING_EVENT_SCHEMA_VERSION),
  idempotencyKey: z.string().min(8).max(200),
  occurredAt: z.string().datetime(),
  eventId: z.string().uuid().optional(),
};

export const appendLearningEventInputSchema = z.discriminatedUnion("type", [
  z.object({
    ...appendBase,
    type: z.literal("attempt"),
    contentId: z.string().uuid(),
    contentVersion: z.number().int().positive(),
    syllabusPointId: z.string().uuid(),
    correctsEventId: z.null().default(null),
    payload: attemptLearningPayloadSchema,
  }),
  z.object({
    ...appendBase,
    type: z.literal("review"),
    contentId: z.string().uuid(),
    contentVersion: z.number().int().positive(),
    syllabusPointId: z.string().uuid().nullable().default(null),
    correctsEventId: z.null().default(null),
    payload: reviewLearningPayloadSchema,
  }),
  z.object({
    ...appendBase,
    type: z.literal("correction"),
    contentId: z.string().uuid().nullable().default(null),
    contentVersion: z.number().int().positive().nullable().default(null),
    syllabusPointId: z.string().uuid().nullable().default(null),
    correctsEventId: z.string().uuid(),
    payload: correctionLearningPayloadSchema,
  }),
]);

export type AttemptLearningPayload = z.infer<typeof attemptLearningPayloadSchema>;
export type ReviewLearningPayload = z.infer<typeof reviewLearningPayloadSchema>;
export type CorrectionLearningPayload = z.infer<typeof correctionLearningPayloadSchema>;
export type LearningEvent = z.infer<typeof learningEventSchema>;
export type AppendLearningEventInput = z.input<typeof appendLearningEventInputSchema>;
