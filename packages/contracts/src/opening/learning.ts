import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const observationOutcomeSchema = z.enum([
  "correct",
  "incorrect",
  "unverified",
]);

export const assistanceLevelSchema = z.enum([
  "independent",
  "hinted",
  "revealed",
  "unknown",
]);

/**
 * Evidence grades for learning-flow claims (research R04).
 * Logs may prove flow ran — never claim course mastery from these alone.
 */
export const learningEvidenceVerdictSchema = z.enum([
  "FLOW_VERIFIED",
  "LEARNING_EFFECT_OBSERVED",
  "MASTERY_NOT_ESTABLISHED",
]);

/** Assistance levels that must never promote to observed_independent. */
export const ASSISTANCE_BLOCKS_INDEPENDENT = [
  "hinted",
  "revealed",
] as const satisfies ReadonlyArray<z.infer<typeof assistanceLevelSchema>>;

export function canBecomeObservedIndependent(
  assistance: z.infer<typeof assistanceLevelSchema>,
  outcome: z.infer<typeof observationOutcomeSchema>,
): boolean {
  if (assistance !== "independent") return false;
  return outcome === "correct";
}

export function shouldCreateLearningSession(
  mode: "hint" | "explain" | "listen" | "think_together",
): boolean {
  return mode === "hint" || mode === "explain";
}

/**
 * Independent credit requires a server problem id plus unaided correct work.
 * Missing problemId => unknown/needs_check path — never observed_independent.
 */
export function observationAllowsIndependent(input: {
  problemId?: string | null;
  assistance: z.infer<typeof assistanceLevelSchema>;
  outcome: z.infer<typeof observationOutcomeSchema>;
}): boolean {
  if (!input.problemId) return false;
  return canBecomeObservedIndependent(input.assistance, input.outcome);
}

export const problemRefSchema = z
  .object({
    problemId: uuidSchema,
    sourceId: uuidSchema,
    sourceVersion: z.number().int().nonnegative(),
    physicalPage: z.number().int().positive().nullable(),
    chunkId: uuidSchema.nullable(),
    stemSnapshot: z.string().min(1).max(2000),
    artifactKind: z.enum(["reference_item", "student_work", "unknown"]),
  })
  .strict();

/** Help counts only after server-confirmed delivery (RU-04). */
export const helpExposureSchema = z
  .object({
    id: uuidSchema,
    sessionId: uuidSchema,
    problemId: uuidSchema.nullable(),
    turnId: uuidSchema,
    level: z.enum(["hinted", "revealed"]),
    delivered: z.literal(true),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const observationInputSchema = z
  .object({
    sessionId: uuidSchema,
    courseId: uuidSchema,
    skillLabel: z.string().min(1).max(200),
    sourceIds: z.array(uuidSchema).max(32),
    /** Optional problem / item linkage within the learning session (RU-04). */
    problemId: uuidSchema.nullable().optional(),
    /** Optional delayed retest linkage (RU-04). */
    retestId: uuidSchema.nullable().optional(),
    answer: z.string().max(20_000),
    outcome: observationOutcomeSchema,
    assistance: assistanceLevelSchema,
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export const learningObservationSchema = observationInputSchema
  .extend({
    id: uuidSchema,
    workspaceId: uuidSchema,
    occurredAt: isoDateTimeSchema,
    sourceTurnIds: z.array(uuidSchema).max(32),
    verdictSource: z.enum([
      "self_report",
      "reference_checked",
      "model_suggestion",
      "unknown",
    ]),
    referenceSourceId: uuidSchema.nullable(),
    evidenceVerdict: learningEvidenceVerdictSchema.default(
      "MASTERY_NOT_ESTABLISHED",
    ),
  })
  .strict();

export const learningSummarySchema = z
  .object({
    skillLabel: z.string().min(1).max(200),
    status: z.enum([
      "unobserved",
      "needs_check",
      "observed_independent",
      "needs_review",
    ]),
    evidenceIds: z.array(uuidSchema).max(200),
    sampleCount: z.number().int().nonnegative(),
    lastObservedAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export const retestCandidateSchema = z
  .object({
    id: uuidSchema,
    courseId: uuidSchema,
    skillLabel: z.string().min(1).max(200),
    prompt: z.string().min(1).max(4000),
    sourceIds: z.array(uuidSchema).max(32),
    dueAt: isoDateTimeSchema,
    accepted: z.boolean(),
  })
  .strict();

export const learningSessionCreateInputSchema = z
  .object({
    courseId: uuidSchema,
    skillLabel: z.string().min(1).max(200),
    sourceIds: z.array(uuidSchema).max(32),
  })
  .strict();

export type ObservationInput = z.infer<typeof observationInputSchema>;
export type LearningObservation = z.infer<typeof learningObservationSchema>;
export type LearningSummary = z.infer<typeof learningSummarySchema>;
export type RetestCandidate = z.infer<typeof retestCandidateSchema>;
export type LearningEvidenceVerdict = z.infer<
  typeof learningEvidenceVerdictSchema
>;
export type LearningSessionCreateInput = z.infer<
  typeof learningSessionCreateInputSchema
>;
export type ProblemRef = z.infer<typeof problemRefSchema>;
export type HelpExposure = z.infer<typeof helpExposureSchema>;
