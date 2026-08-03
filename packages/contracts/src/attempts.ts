import { z } from "zod";

export const abilitySliceSchema = z.enum([
  "recognition",
  "recall",
  "procedure",
  "transfer",
  "expression",
]);

export const practiceItemKindSchema = z.enum(["multiple_choice", "short_answer", "checkpoint"]);

export const practiceItemSchema = z.object({
  id: z.string().uuid(),
  syllabusPointId: z.string().uuid(),
  kind: practiceItemKindSchema,
  stem: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
  answer: z.string().min(1),
  hints: z.array(z.string().min(1)).max(3),
  abilitySlice: abilitySliceSchema,
  estimatedMinutes: z.number().int().min(1).max(60),
  contentVersion: z.number().int().positive(),
});

export const errorCauseSchema = z.enum([
  "concept",
  "misread",
  "calculation",
  "steps",
  "time",
  "other",
]);

export const attemptEventSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  practiceItemId: z.string().uuid(),
  syllabusPointId: z.string().uuid(),
  idempotencyKey: z.string().min(8),
  answer: z.string(),
  correct: z.boolean(),
  assisted: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  hintCount: z.number().int().nonnegative(),
  confidence: z.number().int().min(1).max(5),
  errorCause: errorCauseSchema.nullable(),
  abilitySlice: abilitySliceSchema,
  contentVersion: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
});

export type AbilitySlice = z.infer<typeof abilitySliceSchema>;
export type PracticeItemKind = z.infer<typeof practiceItemKindSchema>;
export type PracticeItem = z.infer<typeof practiceItemSchema>;
export type ErrorCause = z.infer<typeof errorCauseSchema>;
export type AttemptEvent = z.infer<typeof attemptEventSchema>;
