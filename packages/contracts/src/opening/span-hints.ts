import { z } from "zod";
import { uuidSchema } from "./foundation";
import { studyExposureReceiptSchema } from "./tutor";

export const spanHintLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type SpanHintLevel = z.infer<typeof spanHintLevelSchema>;
/** Level 4 remains subject to the server's sealed-original-answer guard. */
export const spanHintRequestSchema = z.object({ attemptId: uuidSchema, level: spanHintLevelSchema.default(1) }).strict();
export const spanHintResponseSchema = z.object({
  attemptId: uuidSchema, level: spanHintLevelSchema, text: z.string().min(1).max(6000), exposureReceipt: studyExposureReceiptSchema,
}).strict();
export type SpanHintResponse = z.infer<typeof spanHintResponseSchema>;
