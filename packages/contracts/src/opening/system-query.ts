import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

const page = { limit: z.number().int().min(1).max(10).default(5), offset: z.number().int().min(0).max(1000).default(0) };
const course = { courseId: uuidSchema };
/** Workspace/owner and executable code are deliberately absent from every tool argument. */
export const systemQueryRequestSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("courses"), arguments: z.object({ query: z.string().max(240).optional(), ...page }).strict() }).strict(),
  z.object({ name: z.literal("learning"), arguments: z.object({ ...course, ...page }).strict() }).strict(),
  z.object({ name: z.literal("recommendation"), arguments: z.object(course).strict() }).strict(),
  z.object({ name: z.literal("materials"), arguments: z.object({ sourceId: uuidSchema.optional(), sourceVersion: z.number().int().nonnegative().optional(), query: z.string().max(240).optional(), physicalPage: z.number().int().positive().max(10000).optional(), ...page }).strict() }).strict(),
  z.object({ name: z.literal("planning"), arguments: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, "Invalid calendar date").optional(), ...page }).strict() }).strict(),
  z.object({ name: z.literal("jobs"), arguments: z.object({ jobId: uuidSchema.optional(), ...page }).strict() }).strict(),
  z.object({ name: z.literal("settings"), arguments: z.object({}).strict() }).strict(),
  z.object({ name: z.literal("teaching"), arguments: z.object({ ...course, ...page }).strict() }).strict(),
]);
export type SystemQueryRequest = z.infer<typeof systemQueryRequestSchema>;
export const systemQueryEvidenceSchema = z.object({
  id: z.string().min(1).max(160), kind: z.string().min(1).max(40), title: z.string().max(200),
  href: z.string().max(500).regex(/^\/opening\/[A-Za-z0-9/?=&%#._-]*$/)
    .refine(value => !/(?:^|\/)\.{1,2}(?:\/|$|[?#])/.test(value) && !/%(?:2e|2f|5c)/i.test(value), "Invalid evidence path"),
  recordId: uuidSchema.optional(), attemptId: uuidSchema.optional(), itemVersionId: uuidSchema.optional(),
  sourceId: uuidSchema.optional(), sourceVersion: z.number().int().nonnegative().optional(), physicalPage: z.number().int().positive().nullable().optional(),
  revision: z.string().max(100).optional(),
}).strict();
export const systemQueryResultSchema = z.object({
  name: z.string().max(40), status: z.enum(["ok", "partial", "unknown"]),
  reason: z.enum(["read", "no_data", "not_available", "invalid_arguments", "truncated", "stale", "timeout", "unavailable", "limit", "repeated_query", "model_unavailable", "model_unsupported"]),
  asOf: isoDateTimeSchema, version: z.string().max(100),
  data: z.array(z.record(z.string(), z.unknown())).max(10),
  evidence: z.array(systemQueryEvidenceSchema).max(10),
  sourceRefs: z.array(z.object({ sourceId: uuidSchema, sourceVersion: z.number().int().nonnegative() }).strict()).max(64),
  nextOffset: z.number().int().nonnegative().nullable(),
}).strict();
export type SystemQueryResult = z.infer<typeof systemQueryResultSchema>;
export const systemQueryReceiptSchema = z.object({
  version: z.literal("study-query-v1"), asOf: isoDateTimeSchema,
  privacyEpoch: z.number().int().nonnegative(),
  mode: z.enum(["native_tools", "deterministic"]),
  status: z.enum(["ok", "partial", "unknown"]),
  reason: z.string().max(100),
  results: z.array(systemQueryResultSchema).max(4),
}).strict();
export type SystemQueryReceipt = z.infer<typeof systemQueryReceiptSchema>;

export const providerToolCallSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(80),
  arguments: z.string().max(4000),
}).strict();
export const providerToolSchema = z.object({
  name: z.string().min(1).max(80), description: z.string().max(1000),
  parameters: z.record(z.string(), z.unknown()),
}).strict();
export const providerToolMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("assistant"), calls: z.array(providerToolCallSchema).min(1).max(4) }).strict(),
  z.object({ role: z.literal("tool"), callId: z.string().min(1).max(200), text: z.string().max(16000) }).strict(),
]);
