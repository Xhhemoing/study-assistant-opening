import { z } from "zod";

export const photoQuestionRecognitionInputSchema = z.object({
  sourceId: z.string().uuid(), sourceVersion: z.number().int().nonnegative(),
}).strict();
/** A transcription candidate, never an answer key or a grading observation. */
export const photoQuestionRecognitionProposalSchema = z.object({
  stem: z.string().max(2000),
  uncertainFragments: z.array(z.object({ fragment: z.string().min(1).max(200), reason: z.string().min(1).max(300) }).strict()).max(20),
}).strict().refine(value => value.stem.trim().length > 0 || value.uncertainFragments.length > 0, "识别结果必须包含题干或无法识别的说明");
export const photoQuestionRecognitionResponseSchema = photoQuestionRecognitionInputSchema.extend({
  jobId: z.string().uuid().nullable(),
  status: z.enum(["idle", "queued", "running", "ready", "failed", "unknown", "cancelled"]),
  proposal: photoQuestionRecognitionProposalSchema.nullable(),
}).strict().refine(value => value.status === "ready" ? value.proposal !== null : value.proposal === null);
export type PhotoQuestionRecognitionInput = z.infer<typeof photoQuestionRecognitionInputSchema>;
export type PhotoQuestionRecognitionProposal = z.infer<typeof photoQuestionRecognitionProposalSchema>;
export type PhotoQuestionRecognitionResponse = z.infer<typeof photoQuestionRecognitionResponseSchema>;
