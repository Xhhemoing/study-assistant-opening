import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { evidenceEligibilitySchema } from "./learning-evidence";
import { teachingActivityStatusSchema, teachingActivityGenerateStatusSchema } from "./teaching-activity";
import { modelTaskKeySchema } from "./ai-settings";
import { goalLearningModeSchema } from "./goal-learning";

const summary = z.string().max(12000), version = z.number().int().nonnegative();
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).nullable();
const route = z.object({ primary: model, fallback: model }).strict();
const taskStatus = z.enum(["pending", "done", "skipped", "unavailable"]);
const jobStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "outcome_unknown"]);
const tool = z.enum(["courses", "learning", "recommendation", "materials", "planning", "jobs", "settings", "teaching", "learner_state", "explain_decision", "notes", "cards", "exam_sprint"]);
const observation = z.object({
  id: uuidSchema, rootId: uuidSchema, attemptId: uuidSchema.nullable(), itemVersionId: uuidSchema.nullable(),
  skillLabel: z.string().max(200).optional(), requirementKey: z.string().max(200).nullable().optional(),
  answerExcerpt: z.string().max(800).optional(), answerTruncated: z.boolean().optional(), answerWithheld: z.literal(true).optional(),
  outcome: z.enum(["correct", "incorrect", "partial", "unverified"]).optional(),
  recordedAssistance: z.enum(["independent", "hinted", "revealed", "unknown"]).optional(),
  effectiveAssistance: z.enum(["independent", "hinted", "revealed", "unknown"]).optional(),
  eligibility: evidenceEligibilitySchema.optional(), projectionFresh: z.boolean(),
  versionApplicability: z.enum(["exact", "equivalent_confirmed", "changed_needs_check", "version_unknown", "unavailable", "privacy_excluded", "unknown"]),
  liveHelpRevision: version, submittedAt: isoDateTimeSchema, summary,
}).strict();
const recommendation = z.union([
  z.object({ identity: z.object({ courseId: uuidSchema, skillLabel: z.string().max(200), requirementKey: z.string().max(200).nullable() }).strict(),
    step: z.object({ activityKind: z.enum(["diagnose", "targeted_explain", "full_explain", "reduced_help_practice", "transfer_check"]),
      focusObservationId: uuidSchema.nullable(), reasonCode: z.enum(["requested_full", "no_evidence", "unverified_only", "verified_incorrect", "assistance_dependent", "independent", "needs_check"]) }).strict(),
    evidenceIds: z.array(uuidSchema).max(10), basis: z.literal("nextLearningStep/current-evidence"), limitations: z.array(z.string().max(200)).max(2), summary }).strict(),
  z.object({ summary, recommendationStatus: z.literal("unknown") }).strict(),
]);
const plan = { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timeZone: z.string().max(100), acceptedVersion: z.number().int().positive(), summary };
export const systemQueryDataSchemas = {
  learner_state: z.object({ summary, stateVersion: z.string().max(200), dataAsOf: isoDateTimeSchema,
    completeness: z.enum(["complete", "partial", "unknown"]), limitations: z.array(z.string().max(300)).max(16) }).strict(),
  explain_decision: z.object({ id: uuidSchema, current: z.boolean(), basis: z.literal("persisted_decision"),
    invalidationReasons: z.array(z.string().max(300)).max(16), summary }).strict(),
  notes: z.object({ id: uuidSchema, title: z.string().max(240), revision: version, updatedAt: isoDateTimeSchema, contentWithheld: z.literal(true), summary }).strict(),
  cards: z.object({ id: uuidSchema, contentVersion: version, courseId: uuidSchema.nullable(), dueAt: isoDateTimeSchema.nullable(),
    answerWithheld: z.literal(true), summary }).strict(),
  exam_sprint: z.object({ id: uuidSchema, updatedAt: isoDateTimeSchema, examDate: z.string().nullable(),
    attemptCount: version, completedCount: version, basis: z.literal("stored_snapshot"), summary }).strict(),
  courses: z.object({ id: uuidSchema, title: z.string().max(240), updatedAt: isoDateTimeSchema,
    goal: z.object({ targetDate: z.string().nullable(), weeklyMinutes: z.number().int().min(0).max(3000), learningMode: goalLearningModeSchema.nullable(), revision: version.nullable() }).strict().nullable(),
    goalStatus: z.enum(["configured", "not_configured", "invalid"]), summary }).strict(),
  learning: observation,
  recommendation,
  materials: z.object({ id: uuidSchema, sourceId: uuidSchema, sourceVersion: version, physicalPage: z.number().int().positive().nullable(),
    excerpt: z.string().max(1200).optional(), truncated: z.boolean(), exposure: z.enum(["not_assessed", "content_withheld"]), summary }).strict(),
  planning: z.union([z.object({ ...plan, taskId: uuidSchema, title: z.string().max(240), start: isoDateTimeSchema, end: isoDateTimeSchema, taskStatus }).strict(), z.object(plan).strict()]),
  jobs: z.object({ id: uuidSchema, kind: z.string().max(80), status: jobStatus, category: z.enum(["background", "tutor"]), updatedAt: isoDateTimeSchema, summary }).strict(),
  settings: z.object({ mode: z.enum(["automatic", "manual"]), defaultModelId: model, manualModelId: model,
    routes: z.object({ listen: model, hint: model, explain: model, think_together: model }).strict(), taskRoutes: z.record(modelTaskKeySchema, route), savedAt: isoDateTimeSchema.nullable(),
    process: z.enum(["web", "worker"]).optional(), adaptivePlanning: z.boolean().optional(), teachingLoop: z.boolean().optional(), summary,
    queryTools: z.array(tool).max(13).optional(), modelConnectivity: z.literal("not_checked").optional(), deployment: z.literal("not_checked").optional(),
    unavailableDomains: z.array(z.enum(["notes", "review_queue", "cost_summary", "historical_material_versions", "persisted_decisions"])).max(5).optional(),
  }).strict(),
  teaching: z.object({ id: uuidSchema, status: teachingActivityStatusSchema, generateStatus: teachingActivityGenerateStatusSchema,
    pathVersion: version, contentVersion: version, updatedAt: isoDateTimeSchema, summary }).strict(),
};
