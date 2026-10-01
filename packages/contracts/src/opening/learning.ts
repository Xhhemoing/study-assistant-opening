import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { evidenceEligibilitySchema, learningObservationFactsShape, referenceCheckInputSchema } from "./learning-evidence";

export const observationOutcomeSchema = z.enum([
  "correct",
  "incorrect",
  "unverified",
]);

export const verdictSourceSchema = z.enum([
  "self_report",
  "reference_checked",
  "model_suggestion",
  "unknown",
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
    attemptId: uuidSchema.nullable().optional(),
    problemId: uuidSchema.nullable(),
    turnId: uuidSchema,
    level: z.enum(["hinted", "revealed"]),
    delivered: z.literal(true),
    deliveredAt: isoDateTimeSchema.nullable().optional(),
    historyRevision: z.number().int().nonnegative().optional(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const observationInputSchema = z
  .object({
    sessionId: uuidSchema,
    attemptId: uuidSchema.nullable().optional(),
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
    /** Server policy input. Omitted requests stay self_report. */
    verdictSource: verdictSourceSchema.optional(),
    referenceCheck: referenceCheckInputSchema.optional(),
    referenceSourceId: uuidSchema.nullable().optional(),
    /** Links a correction. Never an in-place rewrite of the parent row. */
    revisesObservationId: uuidSchema.nullable().optional(),
  })
  .strict();

export const learningObservationSchema = observationInputSchema
  .extend({
    ...learningObservationFactsShape,
    rootObservationId: uuidSchema.optional(),
    revisionKind: z.enum(["original", "replace", "retract"] ).optional(),
    revisionReason: z.string().nullable().optional(),
    actorId: uuidSchema.nullable().optional(),
    effectiveHeadId: uuidSchema.nullable().optional(),
    id: uuidSchema,
    workspaceId: uuidSchema,
    occurredAt: isoDateTimeSchema,
    sourceTurnIds: z.array(uuidSchema).max(32),
    verdictSource: verdictSourceSchema,
    referenceSourceId: uuidSchema.nullable(),
    revisesObservationId: uuidSchema.nullable().optional(),
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
    /** HTTP responses may contain representative IDs; sampleCount remains the full count. */
    evidenceIds: z.array(uuidSchema).max(200),
    /** Distinguishes self-report, model suggestion, and reference-checked evidence. */
    evidenceSources: z.array(verdictSourceSchema).max(4).optional(),
    sampleCount: z.number().int().nonnegative(),
    lastObservedAt: isoDateTimeSchema.nullable(),
    /** Latest original attempts within a known requirement; never a mastery claim. */
    recentPerformance: z.object({
      status: z.enum(["needs_check", "observed_independent"]),
      evidenceIds: z.array(uuidSchema).min(1).max(200),
      /** Full latest-attempt count when evidenceIds are representative; absent in legacy responses. */
      evidenceCount: z.number().int().positive().optional(),
    }).strict().refine(value => value.evidenceCount === undefined || value.evidenceCount >= value.evidenceIds.length, {
      message: "recent evidence count cannot be smaller than its representative IDs", path: ["evidenceCount"],
    }).optional(),
    /** Full verified-error count before the latest attempts, independent of representative IDs. */
    historicalIncorrectCount: z.number().int().nonnegative().optional(),
    /** Unknown correctness is separate from a verified incorrect answer. */
    unverifiedCount: z.number().int().nonnegative().optional(),
    courseId: uuidSchema.optional(),
    requirementKey: z.string().nullable().optional(),
    evidenceEligibility: z.array(z.object({ observationId: uuidSchema, eligibility: evidenceEligibilitySchema, versionApplicability: z.enum(["exact", "equivalent_confirmed", "changed_needs_check", "version_unknown", "unavailable", "privacy_excluded"]).optional() }).strict()).optional(),
  })
  .strict();

export const retestCandidateSchema = z
  .object({
    id: uuidSchema,
    courseId: uuidSchema,
    skillLabel: z.string().min(1).max(200),
    requirementKey: z.string().max(200).nullable().optional(),
    prompt: z.string().min(1).max(4000),
    sourceIds: z.array(uuidSchema).max(32),
    dueAt: isoDateTimeSchema,
    accepted: z.boolean(),
    evidenceObservationIds: z.array(uuidSchema).max(200).optional(),
    evidenceRootIds: z.array(uuidSchema).max(200).optional(),
    invalidated: z.boolean().optional(),
    invalidationReason: z.literal("observation_revised").optional(),
    evidenceChanged: z.boolean().optional(),
    /** Only kind=task may be accepted into an opening task. */
    kind: z.enum(["task", "memory"]).optional(),
  })
  .strict();

export const learningSessionCreateInputSchema = z
  .object({
    courseId: uuidSchema,
    skillLabel: z.string().min(1).max(200),
    requirementKey: z.string().max(200).nullable().optional(),
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
