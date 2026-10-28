import { z } from "zod";
import { uuidSchema,isoDateTimeSchema } from "./foundation";

const workSourceSchema=z.object({id:uuidSchema,version:z.number().int().nonnegative(),physicalPage:z.number().int().positive()}).strict();
export const proofStepFeedbackSchema=z.object({stepIndex:z.number().int().min(1).max(100),claim:z.string().trim().min(1).max(2000),required:z.boolean(),
  verdict:z.enum(["correct","incorrect","unverified"]),feedback:z.string().trim().min(1).max(2000),repairPrompt:z.string().trim().min(1).max(1000)}).strict();
export const proofFeedbackSchema=z.object({coverage:z.enum(["complete","partial","unreadable"]),steps:z.array(proofStepFeedbackSchema).min(1).max(50) }).strict()
  .refine(value=>new Set(value.steps.map(step=>step.stepIndex)).size===value.steps.length,"Step numbers must be unique");
export const answerInterpretationMetadataSchema=z.object({kind:z.literal("photo_transcription"),version:z.number().int().positive(),workSource:workSourceSchema,
  originalTranscriptionObservationId:uuidSchema,originalTranscription:z.string().max(20000),correctedTranscription:z.string().trim().min(1).max(20000),
  previousInterpretationObservationId:uuidSchema.nullable(),correctionReason:z.string().trim().min(1).max(2000)}).strict();
export const answerInterpretationCorrectionSchema=z.object({expectedHead:uuidSchema,correctedTranscription:z.string().trim().min(1).max(20000),
  reason:z.string().trim().min(1).max(2000),clientKey:z.string().min(8).max(160)}).strict();
export const answerInterpretationSnapshotSchema=z.object({rootObservationId:uuidSchema,headObservationId:uuidSchema,originalAnswer:z.string(),
  workSource:workSourceSchema.nullable(),originalTranscriptionObservationId:uuidSchema.nullable(),originalTranscription:z.string().nullable(),
  currentInterpretation:answerInterpretationMetadataSchema.nullable(),
  versions:z.array(z.object({observationId:uuidSchema,metadata:answerInterpretationMetadataSchema,recordedAt:isoDateTimeSchema}).strict()),
  canCorrect:z.boolean(),reason:z.string().nullable()}).strict();
export type ProofFeedback=z.infer<typeof proofFeedbackSchema>;
export type AnswerInterpretationMetadata=z.infer<typeof answerInterpretationMetadataSchema>;
export type AnswerInterpretationCorrection=z.infer<typeof answerInterpretationCorrectionSchema>;
export type AnswerInterpretationSnapshot=z.infer<typeof answerInterpretationSnapshotSchema>;
