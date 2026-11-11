import { z } from "zod";
import { materialImportBindingInputSchema, sha256HexSchema, uuidSchema } from "@aistudy/contracts";
import { learningError } from "./opening-learning-facts";

const revisionSchema = z.number().int().nonnegative().max(2_147_483_647);
export const purposePinSchema = z.object({
  courseId: uuidSchema, materialUse: z.literal("teaching"),
  sources: z.array(z.object({
    sourceId: uuidSchema, sourceVersion: revisionSchema, membershipId: uuidSchema,
    purposeRevision: z.string().min(1), purpose: z.enum(["teaching"]).nullable(),
  }).strict()).length(1),
}).strict();
export const bindingSchema = z.object({
  input: materialImportBindingInputSchema,
  courseId: uuidSchema, purposePin: purposePinSchema,
  questionContentSha256: sha256HexSchema, answerContentSha256: sha256HexSchema,
  acceptedFromRevision: revisionSchema, acceptedRevision: revisionSchema,
  reviewedBy: uuidSchema, reviewedAt: z.string().datetime(), historyRevision: z.number().int().nonnegative().safe(),
}).strict();
export const manifestSchema = z.object({
  schemaVersion: z.literal(1), restoredFromBackup: z.literal(true).optional(), revision: revisionSchema, bindings: z.array(bindingSchema).min(1),
}).strict().superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  for (const binding of manifest.bindings) {
    if (ids.has(binding.input.mappingId) || binding.acceptedFromRevision !== binding.input.expectedManifestRevision
      || binding.acceptedRevision !== binding.acceptedFromRevision + 1 || binding.acceptedRevision > manifest.revision
      || binding.courseId !== binding.purposePin.courseId
      || binding.input.sourceId !== binding.purposePin.sources[0]!.sourceId
      || binding.input.sourceVersion !== binding.purposePin.sources[0]!.sourceVersion) {
      ctx.addIssue({ code: "custom", message: "Inconsistent persisted import binding" });
    }
    ids.add(binding.input.mappingId);
  }
});
export type OpeningMaterialImportBinding = z.infer<typeof bindingSchema>;

type RetainedRow = Record<string, unknown>;
function conflict(message: string): never { throw learningError("CONFLICT", message); }
/** Compare instants at PostgreSQL microsecond precision, never through Date.parse.
 * JSON still obeys bindingSchema's UTC-Z syntax. SQL text may use an offset;
 * fractional digits are right-padded, not rounded. Unsupported precision fails closed. */
function auditInstant(value: unknown): bigint | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    value = value.toISOString();
  }
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = "", zone, sign, zoneHour = "0", zoneMinute = "0"] = match;
  const y = Number(year), m = Number(month), d = Number(day), h = Number(hour), min = Number(minute), s = Number(second);
  const zh = Number(zoneHour), zm = Number(zoneMinute);
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59 || s > 59 || zh > 23 || zm > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  date.setUTCHours(h, min, s, 0);
  // Reject calendar overflow (e.g. February 30) rather than normalizing it.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const offsetMinutes = zone === "Z" ? 0 : (sign === "-" ? -1 : 1) * (zh * 60 + zm);
  return BigInt(date.getTime() - offsetMinutes * 60_000) * 1000n + BigInt(fraction.padEnd(6, "0"));
}
/** Persistent-data boundary shared by current use and restore. Row audit describes
 * only the latest acceptance, not every historical binding. The caller holds the
 * workspace history lock; gaps caused by other semantic writes are legitimate. */
export function validateRetainedMaterialImportState(row: RetainedRow, sourceId: string, sourceVersion: number, watermark: number) {
  const revision = Number(row.material_manifest_revision);
  if (row.material_manifest == null) {
    if (revision !== 0 || row.material_reviewed_by != null || row.material_reviewed_at != null) conflict("audit or revision without manifest");
    return null;
  }
  const parsed = manifestSchema.safeParse(row.material_manifest);
  if (!parsed.success || parsed.data.revision !== revision || parsed.data.bindings.length !== revision
    || !Number.isSafeInteger(watermark) || watermark < 0) conflict("unsupported or inconsistent material manifest");
  const manifest = parsed.data;
  let previousHistory = 0;
  for (const [index, binding] of manifest.bindings.entries()) {
    if (binding.input.sourceId !== sourceId || binding.input.sourceVersion !== sourceVersion
      || binding.acceptedRevision !== index + 1 || binding.historyRevision <= previousHistory
      || binding.historyRevision > watermark) conflict("binding revision or history exceeds retained workspace facts");
    previousHistory = binding.historyRevision;
  }
  const latest = manifest.bindings[manifest.bindings.length - 1]!;
  const reviewedAt = auditInstant(row.material_reviewed_at);
  const bindingReviewedAt = auditInstant(latest.reviewedAt);
  // Acceptances and the restore audit writer support millisecond instants only.
  // Explicitly reject nonzero JSON submilliseconds, even if both sides match;
  // retaining such an instant through that writer would otherwise lose audit data.
  if (reviewedAt === null || bindingReviewedAt === null || bindingReviewedAt % 1000n !== 0n || reviewedAt !== bindingReviewedAt
    || row.material_reviewed_by != null && row.material_reviewed_by !== latest.reviewedBy) conflict("latest material audit disagrees with accepted record");
  // Null FK is legal after account deletion. Retention is not current authority.
  return manifest;
}
