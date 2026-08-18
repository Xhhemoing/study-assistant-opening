import { z } from "zod";
import { statusResultSchema, statusWordSchema } from "./assessment";
import { learningEventSchema } from "./learning-events";

export const assessmentQuerySchema = z
  .object({
    syllabusPointId: z.string().uuid().optional(),
  })
  .strict();

export const assessmentResponseSchema = z.object({
  statuses: z.array(statusResultSchema),
});

export const appendStatusCorrectionRequestSchema = z
  .object({
    correctsEventId: z.string().uuid(),
    kind: z.literal("status"),
    note: z.string().trim().min(1).max(500),
    overrideStatus: statusWordSchema.optional(),
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();

export const appendStatusCorrectionResponseSchema = z.object({
  event: learningEventSchema,
  status: statusResultSchema,
});

export type AssessmentQuery = z.infer<typeof assessmentQuerySchema>;
export type AssessmentResponse = z.infer<typeof assessmentResponseSchema>;
export type AppendStatusCorrectionRequest = z.infer<typeof appendStatusCorrectionRequestSchema>;
export type AppendStatusCorrectionResponse = z.infer<typeof appendStatusCorrectionResponseSchema>;
