import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const TEACHING_EXAMPLE_CONSENT_VERSION = "teaching-example-paid-v1" as const;
export const TEACHING_EXAMPLE_CONSENT_TEXT = "生成同类新例题及完整解答会调用模型并按实际用量计费。预估不是费用上限；结果数学正确性待核。费用或结果未知时不会自动重发。";

/** Identity only. The server loads the owned publication and its source pins. */
export const teachingExampleTargetSchema = z.object({
  activityId: uuidSchema,
  documentId: uuidSchema,
  revisionNumber: z.number().int().positive().safe(),
  blockId: uuidSchema,
  contentVersion: z.number().int().positive().safe(),
}).strict();
export const teachingExampleRequestSchema = z.object({
  clientKey: z.string().trim().min(8).max(120),
  target: teachingExampleTargetSchema,
  consentVersion: z.literal(TEACHING_EXAMPLE_CONSENT_VERSION),
  acceptPaidGeneration: z.literal(true),
}).strict();

/** Read-only estimate; availability is required before admitting a new request. */
export const teachingExampleEstimateSchema = z.object({
  target: teachingExampleTargetSchema,
  estimatedCents: z.number().int().nonnegative().safe(),
  isCap: z.literal(false),
  consentVersion: z.literal(TEACHING_EXAMPLE_CONSENT_VERSION),
  consentText: z.literal(TEACHING_EXAMPLE_CONSENT_TEXT),
}).strict();

const publicationSchema = z.object({
  documentId: uuidSchema,
  revisionNumber: z.number().int().positive().safe(),
  contentVersion: z.number().int().positive().safe(),
  exampleBlockId: uuidSchema,
  solutionBlockId: uuidSchema,
  mathematicalStatus: z.literal("unchecked"),
  assistance: z.literal("revealed"),
  masteryEvidence: z.literal(false),
}).strict();

/** No generated text/keys in status. Succeeded means an atomic publication exists. */
export const teachingExampleStatusSchema = z.object({
  operationId: uuidSchema,
  clientKey: z.string().min(8).max(120),
  target: teachingExampleTargetSchema,
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "outcome_unknown"]),
  estimatedCents: z.number().int().nonnegative().safe(),
  estimateIsCap: z.literal(false),
  /** Publication and billing settle independently; a saved result never clears unknown cost. */
  costState: z.enum(["unsent", "in_flight", "unknown", "completed", "blocked"]),
  publication: publicationSchema.nullable(),
  createdAt: isoDateTimeSchema,
}).strict().superRefine((value, ctx) => {
  if ((value.state === "succeeded") !== (value.publication !== null)) {
    ctx.addIssue({ code: "custom", message: "success requires a durable publication, never just model completion" });
  }
});

/** Untrusted model output: text/LaTeX only, never links, HTML, images or executable TeX. */
const safeText = (max: number) => z.string().trim().min(1).max(max).refine(text =>
  !Array.from(text).some(character => { const code = character.charCodeAt(0); return code < 32 && ![9, 10, 13].includes(code) || code === 127; })
  && !/```|<\/?[a-z!][^>]*>|(?:javascript|data|vbscript)\s*:|!\[|\]\s*\(|https?:\/\/|\\(?:href|url|includegraphics|htmlClass|htmlStyle|htmlId|htmlData|write|input|include|def|gdef|newcommand)\b/i.test(text),
"example accepts plain text and mathematical LaTeX only");
export const teachingExampleProposalSchema = z.object({
  problem: safeText(4000),
  workedSolution: safeText(8000),
}).strict().refine(value => value.problem !== value.workedSolution, "problem and worked solution must be distinct");

export type TeachingExampleTarget = z.infer<typeof teachingExampleTargetSchema>;
export type TeachingExampleRequest = z.infer<typeof teachingExampleRequestSchema>;
export type TeachingExampleEstimate = z.infer<typeof teachingExampleEstimateSchema>;
export type TeachingExampleStatus = z.infer<typeof teachingExampleStatusSchema>;
export type TeachingExampleProposal = z.infer<typeof teachingExampleProposalSchema>;
