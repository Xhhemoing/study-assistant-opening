import { z } from "zod";
import { systemQueryEvidenceSchema } from "./system-query";
import { plannedBlockSchema } from "./planning";
import { calendarDateSchema, isoDateTimeSchema, uuidSchema } from "./foundation";

export const assistantProposalToolSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("propose_teaching_move"), arguments: z.object({ courseId: uuidSchema, topic: z.string().trim().min(1).max(2000) }).strict() }).strict(),
  z.object({ name: z.literal("propose_plan_change"), arguments: z.object({ date: calendarDateSchema, expectedAcceptedVersion: z.number().int().nonnegative() }).strict() }).strict(),
  z.object({ name: z.literal("propose_card"), arguments: z.object({ observationId: uuidSchema, front: z.string().trim().min(1).max(4000), back: z.string().trim().min(1).max(4000) }).strict() }).strict(),
  z.object({ name: z.literal("propose_note"), arguments: z.object({ title: z.string().trim().min(1).max(240), text: z.string().trim().min(1).max(20000) }).strict() }).strict(),
  z.object({ name: z.literal("propose_memory"), arguments: z.object({ text: z.string().trim().min(1).max(4000), courseId: uuidSchema.nullable().optional() }).strict() }).strict(),
  z.object({ name: z.literal("flag_dispute"), arguments: z.object({ rootObservationId: uuidSchema, expectedHead: uuidSchema, reason: z.string().trim().min(1).max(2000) }).strict() }).strict(),
]);
export const assistantProposalCreateSchema = z.object({ clientKey: z.string().min(8).max(180), sourceTurnId: uuidSchema, tool: assistantProposalToolSchema }).strict();
export const assistantProposalDecisionSchema = z.object({ expectedVersion: z.number().int().nonnegative(), action: z.enum(["accept", "reject"]), clientKey: z.string().min(8).max(180) }).strict();
export const assistantProposalRecordSchema = z.object({ id: uuidSchema, sourceTurnId: uuidSchema, tool: assistantProposalToolSchema, version: z.number().int().nonnegative(),
  status: z.enum(["draft", "accepted", "rejected"]), createdAt: isoDateTimeSchema, basisVersion: z.string().max(300),
  result: z.object({ kind: z.string().max(80), id: uuidSchema.nullable(), href: systemQueryEvidenceSchema.shape.href }).strict().nullable(),
  prepared: z.object({ draftId: uuidSchema, expectedBaseVersion: z.number().int().nonnegative(), expectedDraftVersion: z.number().int().nonnegative(),
    preview: z.object({ timeZone: z.string().max(100), previousBlocks: z.array(plannedBlockSchema).max(200), proposedBlocks: z.array(plannedBlockSchema).max(200),
      tasks: z.array(z.object({ id: uuidSchema, title: z.string().max(240) }).strict()).max(600), unscheduledTaskIds: z.array(uuidSchema).max(200),
    }).strict().optional(),
  }).strict().nullable(),
}).strict();
const assistantProposalCursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
export const pendingAssistantProposalsQuerySchema = z.object({
  conversationId: uuidSchema.optional(), cursor: assistantProposalCursorSchema.optional(),
}).strict();
export const pendingAssistantProposalsResponseSchema = z.object({
  proposals: z.array(assistantProposalRecordSchema).max(40),
  nextCursor: assistantProposalCursorSchema.nullable(), total: z.number().int().nonnegative(),
}).strict();
export type AssistantProposalTool = z.infer<typeof assistantProposalToolSchema>;
export type AssistantProposalCreate = z.infer<typeof assistantProposalCreateSchema>;
export type AssistantProposalDecision = z.infer<typeof assistantProposalDecisionSchema>;
export type AssistantProposalRecord = z.infer<typeof assistantProposalRecordSchema>;
export type PendingAssistantProposalsQuery = z.infer<typeof pendingAssistantProposalsQuerySchema>;
export type PendingAssistantProposalsResponse = z.infer<typeof pendingAssistantProposalsResponseSchema>;
