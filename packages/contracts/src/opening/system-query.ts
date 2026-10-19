import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { systemQueryDataSchemas } from "./system-query-data";

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
/** Server-minted grant identity. This describes the owner-only ACL, not a general role revision counter. */
export const systemQueryAuthorizationSchema = z.object({
  purpose: z.enum(["system_record_lookup", "source_review"]),
  workspaceId: uuidSchema, principalId: uuidSchema, role: z.literal("workspace_owner"),
  permissionRevision: z.string().min(1).max(100),
}).strict();
export type SystemQueryAuthorization = z.infer<typeof systemQueryAuthorizationSchema>;
export const systemQueryEvidenceSchema = z.object({
  id: z.string().min(1).max(160), kind: z.string().min(1).max(40), title: z.string().max(200),
  href: z.string().max(500).regex(/^\/opening\/[A-Za-z0-9/?=&%#._-]*$/)
    .refine(value => !/(?:^|\/)\.{1,2}(?:\/|$|[?#])/.test(value) && !/%(?:2e|2f|5c)/i.test(value), "Invalid evidence path"),
  recordId: uuidSchema.optional(), attemptId: uuidSchema.optional(), itemVersionId: uuidSchema.optional(),
  sourceId: uuidSchema.optional(), sourceVersion: z.number().int().nonnegative().optional(), physicalPage: z.number().int().positive().nullable().optional(),
  revision: z.string().max(100).optional(),
}).strict();
const resultFields = {
  authorization: systemQueryAuthorizationSchema,
  status: z.enum(["ok", "partial", "unknown"]),
