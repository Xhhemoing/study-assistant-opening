import { z } from "zod";

export const reviewGradeSchema = z.enum(["again", "hard", "good", "easy"]);

export const reviewQueueModeSchema = z.enum(["auto", "self-selected", "free"]);

const yyyyMmDd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "maintainUntil must be YYYY-MM-DD");

export const reviewCardSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  front: z.string().min(1),
  back: z.string().min(1),
  sourceDocumentId: z.string().uuid().nullable(),
  syllabusPointId: z.string().uuid().nullable(),
  tags: z.array(z.string().min(1)),
  archived: z.boolean(),
  contentVersion: z.number().int().positive().default(1),
  pausedUntil: z.string().datetime().nullable().default(null),
  maintainUntil: yyyyMmDd.nullable().default(null),
  excludeFromAssessment: z.boolean().default(false),
  createdAt: z.string().datetime(),
});

export const reviewStateSchema = z.object({
  cardId: z.string().uuid(),
  ease: z.number().min(1.3),
  intervalDays: z.number().nonnegative(),
  dueAt: z.string().datetime(),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  lastGrade: reviewGradeSchema.nullable(),
  updatedAt: z.string().datetime(),
});

export type ReviewGrade = z.infer<typeof reviewGradeSchema>;
export type ReviewQueueMode = z.infer<typeof reviewQueueModeSchema>;
export type ReviewCard = z.infer<typeof reviewCardSchema>;
export type ReviewState = z.infer<typeof reviewStateSchema>;
