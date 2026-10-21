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
