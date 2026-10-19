import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { systemQueryDataSchemas } from "./system-query-data";

const page = { limit: z.number().int().min(1).max(10).default(5), offset: z.number().int().min(0).max(1000).default(0) };
const course = { courseId: uuidSchema };
/** Workspace/owner and executable code are deliberately absent from every tool argument. */
export const systemQueryRequestSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("courses"), arguments: z.object({ courseId: uuidSchema.optional(), query: z.string().max(240).optional(), ...page }).strict() }).strict(),
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
  reason: z.enum(["read", "no_data", "not_available", "invalid_arguments", "truncated", "stale", "timeout", "unavailable", "limit", "repeated_query", "model_unavailable", "model_unsupported"]),
  asOf: isoDateTimeSchema, version: z.string().max(100),
  evidence: z.array(systemQueryEvidenceSchema).max(10),
  sourceRefs: z.array(z.object({ sourceId: uuidSchema, sourceVersion: z.number().int().nonnegative() }).strict()).max(64),
  nextOffset: z.number().int().nonnegative().nullable(),
};
function resultFor<Name extends keyof typeof systemQueryDataSchemas>(name: Name) {
  return z.object({ ...resultFields, name: z.literal(name), data: z.array(systemQueryDataSchemas[name]).max(10) }).strict();
}
export const systemQueryResultSchema = z.discriminatedUnion("name", [
  resultFor("courses"), resultFor("learning"), resultFor("recommendation"), resultFor("materials"),
  resultFor("planning"), resultFor("jobs"), resultFor("settings"), resultFor("teaching"),
  z.object({ ...resultFields, name: z.literal("rejected"), data: z.array(z.never()).max(0) }).strict(),
]).superRefine((result, ctx) => {
  const included = (sourceId: string, sourceVersion: unknown) => result.sourceRefs.some(ref =>
    ref.sourceId.toLowerCase() === sourceId.toLowerCase() && ref.sourceVersion === sourceVersion);
  for (const [index, row] of result.data.entries()) {
    if ("sourceId" in row && !included(row.sourceId, row.sourceVersion)) ctx.addIssue({ code: "custom", message: "query data source is absent from lineage", path: ["data", index] });
  }
  for (const [index, evidence] of result.evidence.entries()) {
    if ((evidence.sourceId !== undefined || evidence.sourceVersion !== undefined)
      && (!evidence.sourceId || !included(evidence.sourceId, evidence.sourceVersion))) ctx.addIssue({ code: "custom", message: "query evidence source is absent from lineage", path: ["evidence", index] });
    const target = new URL(evidence.href, "https://query.invalid").searchParams;
    if (target.has("source")) {
      const id = target.get("source")!, version = target.get("version");
      if (target.getAll("source").length !== 1 || target.getAll("version").length !== 1
        || !uuidSchema.safeParse(id).success || version === null || !/^\d+$/.test(version) || !included(id, Number(version))
        || (evidence.sourceId !== undefined && evidence.sourceId.toLowerCase() !== id.toLowerCase())
        || (evidence.sourceVersion !== undefined && evidence.sourceVersion !== Number(version))) {
        ctx.addIssue({ code: "custom", message: "query evidence link differs from lineage", path: ["evidence", index, "href"] });
      }
    }
  }
});
export type SystemQueryResult = z.infer<typeof systemQueryResultSchema>;
export const systemQueryReceiptSchema = z.object({
  authorization: systemQueryAuthorizationSchema,
  version: z.literal("study-query-v1"), asOf: isoDateTimeSchema,
  privacyEpoch: z.number().int().nonnegative(),
  mode: z.enum(["native_tools", "deterministic"]),
  status: z.enum(["ok", "partial", "unknown"]),
  reason: z.string().max(100),
  results: z.array(systemQueryResultSchema).max(4),
}).strict().superRefine((receipt, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > 100000) ctx.addIssue({ code: "custom", message: "query receipt exceeds storage budget" });
  for (const result of receipt.results) {
    if ((["purpose", "workspaceId", "principalId", "role", "permissionRevision"] as const).some(key => result.authorization[key] !== receipt.authorization[key])) {
      ctx.addIssue({ code: "custom", message: "query result grant differs from receipt", path: ["results"] });
    }
    if (receipt.authorization.purpose === "system_record_lookup" && result.data.some(row => "excerpt" in row || "answerExcerpt" in row)) {
      ctx.addIssue({ code: "custom", message: "record lookup cannot release protected bodies", path: ["results"] });
    }
  }
});
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
