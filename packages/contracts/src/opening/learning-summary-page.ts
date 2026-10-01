import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { evidenceEligibilitySchema } from "./learning-evidence";
import { verdictSourceSchema } from "./learning";

const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const epochMillisecondsSchema = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const cursorSchema = z.string().min(1).max(4096);

export const courseLearningSummaryInputSchema = z.object({
  courseId: uuidSchema,
  groupCursor: cursorSchema.optional(),
  // Group and representative limits control response size, never learning conclusions.
  limit: z.number().int().min(1).max(50).default(10),
}).strict();

export const learningSummaryAggregateSchema = z.object({
  identity: z.object({
    courseId: uuidSchema,
    // Null and empty are different identities; neither asserts comparable requirements.
    requirementKey: z.string().max(200).nullable(),
    skillLabel: z.string().min(1).max(200),
  }).strict(),
  // Complete counts over visible effective heads in this group, not the representatives.
  sampleCount: countSchema,
  lastObservedAt: isoDateTimeSchema.nullable(),
  /** Original attempt time in epoch milliseconds; corrections do not advance it. */
  latestAttemptAt: epochMillisecondsSchema.nullable(),
  latestAttemptCount: countSchema,
  independentVerifiedCurrentCount: countSchema,
  latestIndependentVerifiedCurrentCount: countSchema,
  historicalIncorrectCount: countSchema,
  /** Earlier independent verified successes remain historical facts after a source version changes. */
  historicalSuccessCount: countSchema,
  applicabilityCounts: z.object({
    exact: countSchema, equivalent_confirmed: countSchema, changed_needs_check: countSchema,
    version_unknown: countSchema, unavailable: countSchema,
  }).strict(),
  unverifiedCount: countSchema,
  evidenceSources: z.array(verdictSourceSchema).max(4),
  representatives: z.array(z.object({
    observationId: uuidSchema,
    rootId: uuidSchema,
    eligibility: evidenceEligibilitySchema,
    versionApplicability: z.enum(["exact", "equivalent_confirmed", "changed_needs_check", "version_unknown", "unavailable", "privacy_excluded"]),
    /** Epoch milliseconds with the same precision as the domain's original-attempt comparison. */
    attemptAt: epochMillisecondsSchema,
  }).strict()).max(20),
  /** Only visible native accepted/in_progress activities; due uses the page's evaluatedAt. */
  openChecks: z.object({
    acceptedCount: countSchema,
    inProgressCount: countSchema,
    dueCount: countSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const reject = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  if (value.latestAttemptCount > value.sampleCount) reject("latestAttemptCount", "Latest attempts exceed complete observations");
  if (value.independentVerifiedCurrentCount > value.sampleCount) reject("independentVerifiedCurrentCount", "Qualified count exceeds complete observations");
  if (value.latestIndependentVerifiedCurrentCount > value.latestAttemptCount
    || value.latestIndependentVerifiedCurrentCount > value.independentVerifiedCurrentCount) {
    reject("latestIndependentVerifiedCurrentCount", "Latest qualified count exceeds its complete count");
  }
  if (value.historicalIncorrectCount > value.sampleCount - value.latestAttemptCount) reject("historicalIncorrectCount", "Historical errors exclude latest attempts");
  if (value.historicalSuccessCount > value.sampleCount - value.latestAttemptCount) reject("historicalSuccessCount", "Historical successes exclude latest attempts");
  if (Object.values(value.applicabilityCounts).reduce((sum, count) => sum + count, 0) !== value.sampleCount) reject("applicabilityCounts", "Applicability counts must cover the complete group");
  if (value.unverifiedCount > value.sampleCount) reject("unverifiedCount", "Unknown correctness exceeds complete observations");
  if (value.sampleCount === 0 && (value.lastObservedAt !== null || value.latestAttemptAt !== null)) reject("sampleCount", "No observations have no observation times");
  if (value.sampleCount > 0 && (value.lastObservedAt === null || value.latestAttemptAt === null || value.latestAttemptCount === 0)) reject("latestAttemptAt", "Observed groups require latest attempt facts");
  if (value.representatives.length > value.sampleCount) reject("representatives", "Representatives exceed complete observations");
  if (value.openChecks.dueCount > value.openChecks.acceptedCount + value.openChecks.inProgressCount) reject("openChecks", "Due checks must be active checks");
});

export const courseLearningSummaryPageSchema = z.object({
  status: z.enum(["ready", "updating"]),
  groups: z.array(learningSummaryAggregateSchema).max(50),
  /** Committed learning-semantic revision; rebuilding derived eligibility does not advance it. */
  snapshotRevision: countSchema,
  /** While updating, this resumes repair of the same group page, not the next group page. */
  nextCursor: cursorSchema.nullable(),
  /** Server evaluation time fixed across this cursor traversal, including activity due checks. */
  evaluatedAt: isoDateTimeSchema,
  pendingProjectionCount: countSchema,
}).strict().superRefine((value, context) => {
  if (value.status === "ready" && value.pendingProjectionCount !== 0) {
    context.addIssue({ code: "custom", path: ["pendingProjectionCount"], message: "Ready pages have no pending projection work" });
  }
  if (value.status === "updating" && (value.groups.length !== 0 || value.pendingProjectionCount === 0)) {
    context.addIssue({ code: "custom", path: ["groups"], message: "Updating pages expose progress, never old or partial group conclusions" });
  }
});

export type LearningSummaryAggregate = z.infer<typeof learningSummaryAggregateSchema>;
export type CourseLearningSummaryInput = z.infer<typeof courseLearningSummaryInputSchema>;
export type CourseLearningSummaryPage = z.infer<typeof courseLearningSummaryPageSchema>;
