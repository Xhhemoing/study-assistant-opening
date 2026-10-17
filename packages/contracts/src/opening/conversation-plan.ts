import { z } from "zod";
import { calendarDateSchema, uuidSchema } from "./foundation";
import { planDraftSchema } from "./planning";

/** A saved tutor candidate is the authority for task text; clients only clarify scope/time. */
export const conversationPlanInputSchema = z.object({
  candidateId: uuidSchema,
  expectedVersion: z.number().int().nonnegative(),
  date: calendarDateSchema,
  expectedAcceptedVersion: z.number().int().nonnegative(),
  clientKey: z.string().min(8).max(200),
  /** Omitted asks the learner to choose; null explicitly means no course. */
  courseId: uuidSchema.nullable().optional(),
  minutes: z.number().int().min(1).max(240).optional(),
}).strict();

export const conversationPlanInspectionSchema = z.object({
  kind: z.literal("clarification"),
  candidate: z.object({
    id: uuidSchema,
    version: z.literal(0),
    title: z.string().min(1).max(240),
    minutes: z.number().int().positive().nullable(),
    dueText: z.string().min(1).max(200).nullable(),
  }).strict(),
  date: calendarDateSchema,
  timeZone: z.string().min(1).max(80),
  planningReady: z.boolean(),
  acceptedVersion: z.number().int().nonnegative(),
  courses: z.array(z.object({ id: uuidSchema, name: z.string().min(1).max(200) }).strict()).max(100),
  missing: z.array(z.enum(["course", "minutes"])).max(2),
}).strict();

/** Stored server projection, validated again when accepting the plan. Never an HTTP input. */
export const conversationPlanMetadataSchema = z.object({
  kind: z.literal("conversation_plan_v1"),
  candidateId: uuidSchema,
  expectedCandidateVersion: z.literal(0),
  sourceTurnId: uuidSchema,
  sourceIds: z.array(uuidSchema).max(32),
  taskId: uuidSchema,
  title: z.string().min(1).max(240),
  minutes: z.number().int().min(1).max(240),
  courseId: uuidSchema.nullable(),
  /** Informal deadline text remains a note, never a guessed absolute date. */
  dueText: z.string().min(1).max(200).nullable(),
}).strict();

export const conversationPlanResultSchema = z.union([
  conversationPlanInspectionSchema,
  z.object({ kind: z.literal("no_change") }).strict(),
  z.object({ kind: z.literal("draft"), draft: planDraftSchema }).strict(),
]);

export type ConversationPlanInput = z.infer<typeof conversationPlanInputSchema>;
export type ConversationPlanInspection = z.infer<typeof conversationPlanInspectionSchema>;
export type ConversationPlanMetadata = z.infer<typeof conversationPlanMetadataSchema>;
export type ConversationPlanResult = z.infer<typeof conversationPlanResultSchema>;
