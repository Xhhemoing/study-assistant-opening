import { z } from "zod";
import { uuidSchema } from "./foundation";

export const knowledgeNodeSchema = z.object({ id: uuidSchema, courseId: uuidSchema, label: z.string().min(1).max(240), kind: z.enum(["chapter", "concept", "procedure", "problem_type"]), evidenceChunkIds: z.array(uuidSchema), status: z.enum(["suggested", "supported", "needs_check"]) }).strict();
export const knowledgeEdgeSchema = z.object({ from: uuidSchema, to: uuidSchema, kind: z.enum(["contains", "prerequisite", "applies_to"]), evidenceChunkIds: z.array(uuidSchema), status: z.enum(["suggested", "supported", "needs_check"]) }).strict();
export const knowledgeSnapshotSchema = z.object({ courseId: uuidSchema, version: z.number().int().nonnegative(), nodes: z.array(knowledgeNodeSchema), edges: z.array(knowledgeEdgeSchema) }).strict();
export const skillEvidenceSchema = z.object({ nodeId: uuidSchema, observationId: uuidSchema, dimension: z.enum(["recall", "explain", "procedure", "transfer", "timed"]) }).strict();
export const tutorActionSchema = z.object({ nodeId: uuidSchema, kind: z.enum(["clarify", "worked_example", "guided", "independent_variant", "delayed_retest"]), evidenceIds: z.array(uuidSchema), reason: z.string().min(1).max(2000) }).strict();
export const courseKnowledgeSyncStatusSchema = z.enum(["empty", "up_to_date", "pending", "needs_rebuild"]);
export const courseKnowledgeFailedJobSchema = z
  .object({
    jobId: uuidSchema,
    state: z.enum(["failed", "outcome_unknown"]),
  })
  .strict();
export const courseKnowledgeRequestedJobSchema = z
  .object({
    jobId: uuidSchema,
    state: z.enum(["queued", "running", "succeeded", "failed", "outcome_unknown", "cancelled"]),
  })
  .strict();
export const courseKnowledgeSyncSchema = z
  .object({
    status: courseKnowledgeSyncStatusSchema,
    activeJobId: uuidSchema.nullable(),
    lastBuiltVersion: z.number().int().nonnegative().nullable(),
    coveredSourceVersions: z.record(z.string(), z.number().int().nonnegative()),
    eligibleSourceVersions: z.record(z.string(), z.number().int().nonnegative()),
    parsingSourceCount: z.number().int().nonnegative(),
    unreadableSourceCount: z.number().int().nonnegative().optional(),
    rebuildBlockedByMaterials: z.boolean().optional(),
    lastFailedJob: courseKnowledgeFailedJobSchema.nullable().optional(),
    requestedJob: courseKnowledgeRequestedJobSchema.nullable().optional(),
  })
  .strict();
export const courseKnowledgeRecordResponseSchema = z
  .object({
    version: z.number().int().nonnegative(),
    snapshot: knowledgeSnapshotSchema,
    sourceVersions: z.record(z.string(), z.number().int().nonnegative()),
    sync: courseKnowledgeSyncSchema.optional(),
  })
  .strict();
export type KnowledgeNode = z.infer<typeof knowledgeNodeSchema>;
export type KnowledgeEdge = z.infer<typeof knowledgeEdgeSchema>;
export type KnowledgeSnapshot = z.infer<typeof knowledgeSnapshotSchema>;
export type SkillEvidence = z.infer<typeof skillEvidenceSchema>;
export type TutorAction = z.infer<typeof tutorActionSchema>;
export type CourseKnowledgeSyncStatus = z.infer<typeof courseKnowledgeSyncStatusSchema>;
export type CourseKnowledgeFailedJob = z.infer<typeof courseKnowledgeFailedJobSchema>;
export type CourseKnowledgeRequestedJob = z.infer<typeof courseKnowledgeRequestedJobSchema>;
export type CourseKnowledgeSync = z.infer<typeof courseKnowledgeSyncSchema>;
export type CourseKnowledgeRecordResponse = z.infer<typeof courseKnowledgeRecordResponseSchema>;
