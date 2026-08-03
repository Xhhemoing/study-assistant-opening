import { z } from "zod";

export const reviewGradeSchema = z.enum(["again", "hard", "good", "easy"]);

export const reviewCardSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  front: z.string().min(1),
  back: z.string().min(1),
  sourceDocumentId: z.string().uuid().nullable(),
  tags: z.array(z.string().min(1)),
  archived: z.boolean(),
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
export type ReviewCard = z.infer<typeof reviewCardSchema>;
export type ReviewState = z.infer<typeof reviewStateSchema>;
