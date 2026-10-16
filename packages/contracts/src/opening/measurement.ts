import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

/** Versioned, opt-in measurement. These records never assert production mastery. */
export type MeasurementPhase = "practice" | "delay_48h" | "delay_7d";
export type MeasurementHelpKind = "hint" | "solution" | "external";
export type MeasurementModelManifest = {
  id: string; version: string; label: string; calibrated: false;
  parameters: Record<string, number>;
};
export type MeasurementPrediction = {
  modelId: string; modelVersion: string; probability: number;
  predictedAt: string; evidenceAttemptIds: string[];
};
export type MeasurementItemView = {
  id: string; version: string; skillId: string; skillLabel: string; familyId: string;
  phase: MeasurementPhase; prompt: string;
  options: Array<{ id: string; label: string }>;
};
export type MeasurementAttempt = {
  id: string; trialId: string; ordinal: number; item: MeasurementItemView;
  presentedAt: string; answeredAt: string | null; dueAt: string | null;
  firstAttempt: boolean;
  helpEvents: Array<{ kind: MeasurementHelpKind; recordedAt: string }>;
  answer: string | null; outcome: "correct" | "incorrect" | "skipped" | null;
  retractedAt: string | null; retractionReason: string | null;
  predictions: MeasurementPrediction[];
  feedback: string | null; feedbackWithheld: boolean;
};
export type MeasurementTrial = {
  id: string; courseId: string; unitId: string; protocolVersion: string;
  bankVersion: string; models: MeasurementModelManifest[];
  selectionPolicy: "fixed-common-probes-v1";
  status: "active" | "paused" | "completed";
  startedAt: string; practiceCompletedAt: string | null;
};
export type MeasurementCalibrationBin = {
  lower: number; upper: number; count: number;
  meanPrediction: number | null; observedAccuracy: number | null;
};
export type MeasurementModelScore = {
  modelId: string; modelVersion: string; count: number;
  brier: number | null; logLoss: number | null;
  calibration: MeasurementCalibrationBin[];
};
export type MeasurementReport = {
  conclusion: "insufficient_evidence";
  presented: number; answered: number; pending: number; skipped: number;
  eligible: number; excluded: Record<string, number>;
  models: MeasurementModelScore[];
  byPhase: Array<{ phase: MeasurementPhase; eligible: number; models: MeasurementModelScore[] }>;
  bySkill: Array<{ skillId: string; eligible: number; models: MeasurementModelScore[] }>;
  pairedBrierDifference: number | null;
  pairedLogLossDifference: number | null;
};
export type MeasurementOverview = {
  trial: MeasurementTrial | null;
  attempts: MeasurementAttempt[];
  nextDueAt: string | null;
  report: MeasurementReport;
};
export type MeasurementExport = MeasurementOverview & {
  format: "aistudy-measurement-v1"; exportedAt: string;
  limitations: string[];
};

export const measurementModelManifestSchema: z.ZodType<MeasurementModelManifest> = z.object({
  id: z.string().min(1), version: z.string().min(1), label: z.string(), calibrated: z.literal(false),
  parameters: z.record(z.string(), z.number().finite()),
}).strict();
export const measurementPredictionSchema: z.ZodType<MeasurementPrediction> = z.object({
  modelId: z.string().min(1), modelVersion: z.string().min(1), probability: z.number().min(0).max(1),
  predictedAt: isoDateTimeSchema, evidenceAttemptIds: z.array(uuidSchema),
}).strict();
export const measurementPhaseSchema = z.enum(["practice", "delay_48h", "delay_7d"]);
export const measurementItemViewSchema: z.ZodType<MeasurementItemView> = z.object({
  id: z.string().min(1), version: z.string().min(1), skillId: z.string().min(1), skillLabel: z.string(),
  familyId: z.string().min(1), phase: measurementPhaseSchema, prompt: z.string().min(1),
  options: z.array(z.object({ id: z.string().min(1), label: z.string() }).strict()).length(4),
}).strict();
export const measurementAttemptSchema: z.ZodType<MeasurementAttempt> = z.object({
  id: uuidSchema, trialId: uuidSchema, ordinal: z.number().int().positive(), item: measurementItemViewSchema,
  presentedAt: isoDateTimeSchema, answeredAt: isoDateTimeSchema.nullable(), dueAt: isoDateTimeSchema.nullable(),
  firstAttempt: z.boolean(),
  helpEvents: z.array(z.object({ kind: z.enum(["hint", "solution", "external"]), recordedAt: isoDateTimeSchema }).strict()),
  answer: z.string().nullable(), outcome: z.enum(["correct", "incorrect", "skipped"]).nullable(),
  retractedAt: isoDateTimeSchema.nullable(), retractionReason: z.string().nullable(),
  predictions: z.array(measurementPredictionSchema), feedback: z.string().nullable(), feedbackWithheld: z.boolean(),
}).strict();
export const measurementTrialSchema: z.ZodType<MeasurementTrial> = z.object({
  id: uuidSchema, courseId: uuidSchema, unitId: z.string().min(1), protocolVersion: z.string().min(1),
  bankVersion: z.string().min(1), models: z.array(measurementModelManifestSchema).min(1),
  selectionPolicy: z.literal("fixed-common-probes-v1"), status: z.enum(["active", "paused", "completed"]),
  startedAt: isoDateTimeSchema, practiceCompletedAt: isoDateTimeSchema.nullable(),
}).strict();
const calibrationBinSchema: z.ZodType<MeasurementCalibrationBin> = z.object({
  lower: z.number(), upper: z.number(), count: z.number().int().nonnegative(),
  meanPrediction: z.number().nullable(), observedAccuracy: z.number().nullable(),
}).strict();
const modelScoreSchema: z.ZodType<MeasurementModelScore> = z.object({
  modelId: z.string(), modelVersion: z.string(), count: z.number().int().nonnegative(),
  brier: z.number().nullable(), logLoss: z.number().nullable(), calibration: z.array(calibrationBinSchema),
}).strict();
export const measurementReportSchema: z.ZodType<MeasurementReport> = z.object({
  conclusion: z.literal("insufficient_evidence"), presented: z.number().int().nonnegative(),
  answered: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(), excluded: z.record(z.string(), z.number().int().nonnegative()),
  models: z.array(modelScoreSchema),
  byPhase: z.array(z.object({ phase: measurementPhaseSchema, eligible: z.number().int().nonnegative(), models: z.array(modelScoreSchema) }).strict()),
  bySkill: z.array(z.object({ skillId: z.string(), eligible: z.number().int().nonnegative(), models: z.array(modelScoreSchema) }).strict()),
  pairedBrierDifference: z.number().nullable(), pairedLogLossDifference: z.number().nullable(),
}).strict();
export const measurementOverviewSchema: z.ZodType<MeasurementOverview> = z.object({
  trial: measurementTrialSchema.nullable(), attempts: z.array(measurementAttemptSchema),
  nextDueAt: isoDateTimeSchema.nullable(), report: measurementReportSchema,
}).strict();
export const measurementExportSchema: z.ZodType<MeasurementExport> = z.object({
  trial: measurementTrialSchema.nullable(), attempts: z.array(measurementAttemptSchema),
  nextDueAt: isoDateTimeSchema.nullable(), report: measurementReportSchema,
  format: z.literal("aistudy-measurement-v1"), exportedAt: isoDateTimeSchema, limitations: z.array(z.string()),
}).strict();

const clientKey = z.string().trim().min(8).max(200);
export const measurementStartInputSchema = z.object({
  courseId: uuidSchema, unitId: z.literal("calculus-parts-v1"), clientKey,
}).strict();
export const measurementStatusInputSchema = z.object({
  trialId: uuidSchema, status: z.enum(["active", "paused"]),
}).strict();
export const measurementNextInputSchema = z.object({ trialId: uuidSchema, clientKey }).strict();
export const measurementActionInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("answer"), clientKey, answer: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("help"), clientKey, kind: z.enum(["hint", "solution", "external"]) }).strict(),
  z.object({ action: z.literal("skip"), clientKey }).strict(),
  z.object({ action: z.literal("retract"), clientKey, reason: z.string().trim().min(1).max(500) }).strict(),
]);
export type MeasurementStartInput = z.infer<typeof measurementStartInputSchema>;
export type MeasurementStatusInput = z.infer<typeof measurementStatusInputSchema>;
export type MeasurementNextInput = z.infer<typeof measurementNextInputSchema>;
export type MeasurementActionInput = z.infer<typeof measurementActionInputSchema>;
