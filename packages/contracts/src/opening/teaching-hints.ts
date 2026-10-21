import { z } from "zod";
import { uuidSchema } from "./foundation";
import { studyExposureReceiptSchema } from "./tutor";

/** Model-written, question-specific content. Kept in the hidden answer-key block. */
export const teachingPartialHintsSchema = z.object({
  direction: z.string().trim().min(1).max(4000),
  concept: z.string().trim().min(1).max(4000),
  firstStep: z.string().trim().min(1).max(4000),
}).strict();
export type TeachingPartialHints = z.infer<typeof teachingPartialHintsSchema>;

/** Server-side teaching data, never part of a hidden question's client projection. */
export const teachingMisconceptionIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/).refine(id => id !== "other", "other is reserved for an unmatched error");
export const teachingMisconceptionsSchema = z.array(z.object({
  id: teachingMisconceptionIdSchema,
  manifestation: z.string().trim().min(1).max(800),
  reason: z.string().trim().min(1).max(1200),
  correction: z.string().trim().min(1).max(1200),
}).strict()).min(2).max(3).refine(items => new Set(items.map(item => item.id)).size === items.length, "misconception IDs must be distinct");
export type TeachingMisconception = z.infer<typeof teachingMisconceptionsSchema>[number];
export const teachingStartChoiceSchema = z.object({
  correct: z.object({ step: z.string().trim().min(1).max(500), why: z.string().trim().min(1).max(1000) }).strict(),
  misconception: z.object({ step: z.string().trim().min(1).max(500), why: z.string().trim().min(1).max(1000), misconceptionId: teachingMisconceptionIdSchema }).strict(),
}).strict().refine(choice => choice.correct.step !== choice.misconception.step, "starting directions must differ");
export type TeachingStartChoice = z.infer<typeof teachingStartChoiceSchema>;
export const teachingHintLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type TeachingHintLevel = z.infer<typeof teachingHintLevelSchema>;
export const teachingHintRequestSchema = z.object({ attemptId: uuidSchema, level: teachingHintLevelSchema }).strict();
export const teachingHintResponseSchema = z.object({
  attemptId: uuidSchema,
  level: teachingHintLevelSchema,
  text: z.string().trim().min(1).max(20_000),
  referenceSourceId: uuidSchema.nullable(),
  exposureReceipt: studyExposureReceiptSchema,
}).strict();
export type TeachingHintResponse = z.infer<typeof teachingHintResponseSchema>;
