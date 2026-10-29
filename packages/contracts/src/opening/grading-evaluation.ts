import { z } from "zod";
import { isoDateTimeSchema } from "./foundation";

const identity = z.string().trim().min(1).max(160);
const outcome = z.enum(["correct", "incorrect", "unverified"]);
const gradingCaseInputSchema = z.object({
  question: z.string().min(1).max(20_000), answer: z.string().max(20_000), referenceText: z.string().max(20_000),
  /** Immutable local evaluation asset identity; never assume a missing photo was tested. */
  imageEvidenceRef: identity.nullable(),
}).strict();
export const gradingEvaluationDatasetSchema = z.object({
  protocolVersion: z.literal("grading-evaluation-v1"), datasetId: identity, datasetVersion: identity,
  cases: z.array(z.object({
    id: identity, version: identity,
    group: z.enum(["equivalent_solution", "step_error", "partial_answer", "ambiguous_photo", "question_mismatch", "insufficient_information"]),
    modality: z.enum(["text", "photo"]), input: gradingCaseInputSchema,
    /** An assistant-authored suggestion for review, never scoring truth. */
    candidateOutcome: outcome, candidateRationale: z.string().min(1).max(4000),
    review: z.discriminatedUnion("status", [
      z.object({ status: z.literal("pending") }).strict(),
      z.object({ status: z.literal("human_reviewed"), reviewerId: identity, reviewedAt: isoDateTimeSchema,
        outcome, rationale: z.string().min(1).max(4000) }).strict(),
      // A machine-checkable objective answer is not an expert's review of teaching quality.
      z.object({ status: z.literal("program_verified"), checker: z.literal("exact-arithmetic-v1"),
        verifiedAt: isoDateTimeSchema, outcome: z.enum(["correct", "incorrect"]),
        rationale: z.string().min(1).max(4000) }).strict(),
    ]),
  }).strict()).min(1).max(1000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.cases.map(row => row.id)).size !== value.cases.length) ctx.addIssue({ code: "custom", message: "Duplicate grading case" });
  for (const row of value.cases) {
    if (row.modality === "text" && row.input.imageEvidenceRef !== null
      || row.modality === "photo" && row.review.status !== "pending" && row.input.imageEvidenceRef === null
      || row.modality !== "text" && row.review.status === "program_verified") {
      ctx.addIssue({ code: "custom", message: "Review modality requires matching evidence" });
    }
  }
});
export const gradingEvaluationRunSchema = z.object({
  datasetId: identity, datasetVersion: identity, modelLabel: identity, completedAt: isoDateTimeSchema,
  provenance: z.enum(["real_provider", "test_fixture"]),
  /** Explicit unknown is allowed for historical fixtures; never infer current versions. */
  sourceCommit: identity,
  instructionVersion: identity,
  rubricVersion: identity,
  protocolVersion: identity,
  promptDigest: identity,
  results: z.array(z.object({ caseId: identity, caseVersion: identity, input: gradingCaseInputSchema,
    /** Keep invalid output as a failed result, rather than silently dropping the case. */
    rawOutput: z.string().max(80_000),
  }).strict()).max(1000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.results.map(row => row.caseId)).size !== value.results.length) ctx.addIssue({ code: "custom", message: "Duplicate grading result" });
});
export type GradingEvaluationDataset = z.infer<typeof gradingEvaluationDatasetSchema>;
export type GradingEvaluationRun = z.infer<typeof gradingEvaluationRunSchema>;
