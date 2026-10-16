import { z } from "zod";
import { isoDateTimeSchema } from "./foundation";
const qualificationCountsSchema = z.object({
  observations: z.number().int().nonnegative(),
  independentVerifiedCurrent: z.number().int().nonnegative(),
  unknownQualification: z.number().int().nonnegative(),
}).strict();
/** No IDs, answers, material excerpts or claimed mastery are sent to a planning conversation. */
export const conversationPlanningContextSchema = z.object({
  version: z.literal("conversation-planning-v1"),
  asOf: isoDateTimeSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.string().min(1).max(80),
  settings: z.enum(["configured", "not_configured", "invalid"]),
  acceptedVersion: z.number().int().nonnegative(),
  courses: z.array(z.object({ alias: z.string().regex(/^c\d+$/), name: z.string().min(1).max(60) }).strict()).max(20),
  tasks: z.array(z.object({ alias: z.string().regex(/^t\d+$/), title: z.string().min(1).max(60),
    minutes: z.number().int().positive(), courseAlias: z.string().regex(/^c\d+$/).nullable(), deferred: z.boolean() }).strict()).max(20),
  acceptedSlots: z.array(z.object({ taskAlias: z.string().regex(/^t\d+$/).nullable(), start: isoDateTimeSchema, end: isoDateTimeSchema }).strict()).max(20),
  hardSlots: z.array(z.object({ kind: z.enum(["class", "sleep", "meal", "locked"]), start: isoDateTimeSchema, end: isoDateTimeSchema }).strict()).max(20),
  learning: z.object({ status: z.enum(["available", "limited"]), windowDays: z.literal(14), counts: qualificationCountsSchema.nullable() }).strict(),
  truncated: z.boolean(),
}).strict();
export type ConversationPlanningContext = z.infer<typeof conversationPlanningContextSchema>;
