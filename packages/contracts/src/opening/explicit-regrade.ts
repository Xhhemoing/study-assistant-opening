import { z } from "zod";
import { aiGradingWorkSourceSchema } from "./ai-evaluation";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const EXPLICIT_REGRADE_CONFIRMATION_VERSION = "double-charge-v1" as const;
export const EXPLICIT_REGRADE_CONFIRMATION_TEXT = "旧请求可能已经收费且费用仍未确认；本次是新的 AI 批改，会另行计费，两次都可能收费。";

/** The server captures all paid-input identity. No client operation or photo override. */
export const explicitRegradePrepareSchema = z.object({
  observationId: uuidSchema,
  expectedHead: uuidSchema,
  expectedGradingVersion: z.number().int().nonnegative(),
  clientKey: z.string().trim().min(1).max(200),
}).strict();

export const explicitRegradeConfirmSchema = z.object({
  requestId: uuidSchema,
  confirmationVersion: z.literal(EXPLICIT_REGRADE_CONFIRMATION_VERSION),
  acceptPossibleDoubleCharge: z.literal(true),
}).strict();

export const explicitRegradeRequestSchema = z.object({
  requestId: uuidSchema,
  rootObservationId: uuidSchema,
  expectedHead: uuidSchema,
  answerRevision: z.number().int().positive(),
  privacyEpoch: z.number().int().nonnegative(),
  previousGradingVersion: z.number().int().nonnegative(),
  gradingVersion: z.number().int().positive(),
  previousOperationId: z.string().min(1),
  operationId: z.string().min(1),
  confirmationVersion: z.literal(EXPLICIT_REGRADE_CONFIRMATION_VERSION),
  confirmationText: z.literal(EXPLICIT_REGRADE_CONFIRMATION_TEXT),
  workSource: aiGradingWorkSourceSchema.nullable(),
  state: z.enum(["prepared", "confirmed"]),
  confirmedAt: isoDateTimeSchema.nullable(),
  jobId: uuidSchema.nullable(),
  resultObservationId: uuidSchema.nullable(),
}).strict();

export type ExplicitRegradePrepare = z.infer<typeof explicitRegradePrepareSchema>;
export type ExplicitRegradeConfirm = z.infer<typeof explicitRegradeConfirmSchema>;
export type ExplicitRegradeRequest = z.infer<typeof explicitRegradeRequestSchema>;
