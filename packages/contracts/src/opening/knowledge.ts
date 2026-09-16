import { z } from "zod";
import { uuidSchema } from "./foundation";

export const knowledgeNodeSchema = z.object({ id: uuidSchema, courseId: uuidSchema, label: z.string().min(1).max(240), kind: z.enum(["chapter", "concept", "procedure", "problem_type"]), evidenceChunkIds: z.array(uuidSchema), status: z.enum(["suggested", "supported", "needs_check"]) }).strict();
export const knowledgeEdgeSchema = z.object({ from: uuidSchema, to: uuidSchema, kind: z.enum(["contains", "prerequisite", "applies_to"]), evidenceChunkIds: z.array(uuidSchema), status: z.enum(["suggested", "supported", "needs_check"]) }).strict();
export const knowledgeSnapshotSchema = z.object({ courseId: uuidSchema, version: z.number().int().nonnegative(), nodes: z.array(knowledgeNodeSchema), edges: z.array(knowledgeEdgeSchema) }).strict();
export const skillEvidenceSchema = z.object({ nodeId: uuidSchema, observationId: uuidSchema, dimension: z.enum(["recall", "explain", "procedure", "transfer", "timed"]) }).strict();
export const tutorActionSchema = z.object({ nodeId: uuidSchema, kind: z.enum(["clarify", "worked_example", "guided", "independent_variant", "delayed_retest"]), evidenceIds: z.array(uuidSchema), reason: z.string().min(1).max(2000) }).strict();
export type KnowledgeNode = z.infer<typeof knowledgeNodeSchema>;
export type KnowledgeEdge = z.infer<typeof knowledgeEdgeSchema>;
export type KnowledgeSnapshot = z.infer<typeof knowledgeSnapshotSchema>;
export type SkillEvidence = z.infer<typeof skillEvidenceSchema>;
export type TutorAction = z.infer<typeof tutorActionSchema>;
