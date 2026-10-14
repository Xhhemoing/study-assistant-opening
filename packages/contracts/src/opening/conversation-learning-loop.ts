import { z } from "zod";
import { evidenceEligibilitySchema } from "./learning-evidence";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { plannedBlockSchema, taskItemSchema } from "./planning";

/**
 * Read-only learning-agent preview. Course ownership, evidence and timetable are
 * supplied by the server, never by the caller or by LLM-generated JSON.
 */
export const conversationLearningPreviewInputSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  courseId: uuidSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export const conversationLearningIntentSchema = z.object({
  version: z.literal("conversation-intent-v1"),
  extraction: z.literal("rule_fallback"),
  kind: z.enum(["study_and_plan", "study_only", "plan_only", "unknown"]),
  topic: z.string().min(1).max(200).nullable(),
  examInDays: z.number().int().min(0).max(365).nullable(),
  dailyMinutes: z.number().int().min(10).max(240).nullable(),
  selfReportedDifficulty: z.boolean(),
  preferredStyle: z.enum(["explain_then_practice", "practice_first", "unspecified"]),
  missing: z.array(z.enum(["topic", "exam_date", "time_budget"])).max(3),
}).strict();

export const conversationSkillStatusSchema = z.enum([
  "unobserved", "needs_check", "needs_review", "observed_independent", "unknown",
]);

/** A status is evidence-derived. "I don't understand" is a learner claim, not verified performance. */
export const conversationSkillEvidenceSchema = z.object({
  label: z.string().min(1).max(200),
  status: conversationSkillStatusSchema,
  sampleCount: z.number().int().nonnegative(),
  verifiedIndependentCount: z.number().int().nonnegative(),
  dueRetest: z.boolean(),
}).strict();

export const conversationDiagnosisSchema = z.object({
  topic: z.string().min(1).max(200).nullable(),
  evidenceStatus: conversationSkillStatusSchema,
  evidenceCount: z.number().int().nonnegative(),
  action: z.enum(["diagnostic", "guided_repair", "delayed_retest", "transfer_check"]),
  reasonCodes: z.array(z.enum([
    "topic_unmatched", "self_report_not_evidence", "no_qualified_evidence",
    "evidence_needs_check", "retest_due", "recent_independence", "summary_updating",
    "material_unavailable",
  ])).max(8),
  /** No preview can upgrade knowledge state. Only the persisted assessment pipeline can. */
  masteryUpdated: z.literal(false),
}).strict();

export const conversationSessionStepSchema = z.object({
  kind: z.enum([
    "diagnostic", "explain", "guided_repair", "independent_practice",
    "transfer_check", "delayed_retest", "reflection",
  ]),
  minutes: z.number().int().positive().max(240),
  /** No studying/completing a step alone supplies independent evidence. */
  evidenceRequired: z.enum(["none", "verified_independent_attempt", "verified_delayed_attempt"]),
  contingentOnPriorResult: z.boolean(),
}).strict();

export const conversationSessionPreviewSchema = z.object({
  totalMinutes: z.number().int().min(10).max(240),
  steps: z.array(conversationSessionStepSchema).min(1).max(6),
  conditional: z.literal(true),
}).strict();

export const conversationPlanPreviewSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["scheduled", "unscheduled", "no_planning_settings"]),
  proposedClientKey: z.string().min(8).max(200),
  proposedTask: taskItemSchema,
  proposedBlock: plannedBlockSchema.nullable(),
  /** Existing confirmed blocks are locks, not rewritten by this preview. */
  retainedAcceptedBlockCount: z.number().int().nonnegative(),
  unscheduledReason: z.string().max(200).nullable(),
  isCommitted: z.literal(false),
}).strict();

export const conversationLearningPreviewSchema = z.object({
  policyVersion: z.literal("conversation-learning-v1"),
  courseId: uuidSchema,
  intent: conversationLearningIntentSchema,
  diagnosis: conversationDiagnosisSchema,
  session: conversationSessionPreviewSchema,
  plan: conversationPlanPreviewSchema,
  warnings: z.array(z.string().min(1).max(300)).max(10),
  readOnly: z.literal(true),
}).strict();

/**
 * Trusted INTERNAL input only: the caller must obtain eligibility from the
 * server-owned observation/eligibility projection, not from a chat utterance.
 */
export const conversationEvidenceReplanInputSchema = z.object({
  observationId: uuidSchema,
  outcome: z.enum(["correct", "incorrect", "unverified"]),
  assistance: z.enum(["independent", "hinted", "revealed", "unknown"]),
  eligibility: evidenceEligibilitySchema,
  remainingMinutes: z.number().int().min(0).max(240),
}).strict();

export const conversationEvidenceReplanSchema = z.object({
  policyVersion: z.literal("conversation-learning-v1"),
  action: z.enum(["verify_evidence", "guided_repair", "independent_retry", "transfer_check", "consider_next_topic"]),
  nextSteps: z.array(conversationSessionStepSchema).max(6),
  reasonCodes: z.array(z.string().min(1).max(120)).min(1).max(8),
  masteryUpdated: z.literal(false),
}).strict();

export type ConversationLearningPreviewInput = z.infer<typeof conversationLearningPreviewInputSchema>;
export type ConversationLearningIntent = z.infer<typeof conversationLearningIntentSchema>;
export type ConversationSkillEvidence = z.infer<typeof conversationSkillEvidenceSchema>;
export type ConversationDiagnosis = z.infer<typeof conversationDiagnosisSchema>;
export type ConversationSessionStep = z.infer<typeof conversationSessionStepSchema>;
export type ConversationSessionPreview = z.infer<typeof conversationSessionPreviewSchema>;
export type ConversationLearningPreview = z.infer<typeof conversationLearningPreviewSchema>;
export type ConversationEvidenceReplanInput = z.infer<typeof conversationEvidenceReplanInputSchema>;
export type ConversationEvidenceReplan = z.infer<typeof conversationEvidenceReplanSchema>;
