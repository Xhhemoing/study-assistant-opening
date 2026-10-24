import { z } from "zod";
import { studyContextAnchorSchema, studyExposureReceiptSchema } from "@aistudy/contracts";

/** Reader-only, bounded same-page material, never an AI definition. Offsets are UTF-16. */
export const conceptPreviewRequestSchema = z.object({
  sourceId: z.string().uuid(), sourceVersion: z.number().int().nonnegative(), page: z.number().int().positive(),
  term: z.string().trim().min(1).max(240),
  selection: z.object({ text: z.string().min(1).max(1200), start: z.number().int().nonnegative().optional(), end: z.number().int().positive().optional() }).strict()
    .refine(s => (s.start == null) === (s.end == null) && (s.start == null || s.end! > s.start), "Invalid selection offsets").optional(),
  clientKey: z.string().min(1).max(119).regex(/^[a-zA-Z0-9:_-]+$/),
}).strict();
export type ConceptPreviewRequest = z.infer<typeof conceptPreviewRequestSchema>;
const selectionSchema = z.object({ text: z.string().min(1).max(1200), start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
export const conceptPreviewResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"), kind: z.literal("source_excerpt"), text: z.string().min(1).max(1200), term: z.string().min(1).max(240),
    selection: selectionSchema,
    context: z.object({ scope: z.literal("same_page_paragraph"), expanded: z.boolean(), truncatedBefore: z.boolean(), truncatedAfter: z.boolean() }).strict(),
    locator: z.object({ sourceId: z.string().uuid(), sourceVersion: z.number().int().nonnegative(), page: z.number().int().positive(), start: z.number().int().nonnegative(), end: z.number().int().positive(), manifestRevision: z.number().int().nonnegative() }).strict(),
    contextAnchor: studyContextAnchorSchema, exposureReceipts: z.array(studyExposureReceiptSchema).length(1),
  }).strict(),
  z.object({ status: z.literal("ambiguous"), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("restricted"), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("stale"), reason: z.string().min(1) }).strict(),
]).superRefine((value, ctx) => {
  if (value.status !== "available") return;
  const { locator: l, selection: s } = value;
  const matches = (anchor: z.infer<typeof studyContextAnchorSchema>) => anchor.sourceId === l.sourceId && anchor.sourceVersion === l.sourceVersion && anchor.page === l.page && anchor.purpose === "material_read" && !anchor.attemptId && !anchor.itemVersionId;
  if (l.end - l.start !== value.text.length || s.end - s.start !== s.text.length || s.start < l.start || s.end > l.end || value.text.slice(s.start - l.start, s.end - l.start) !== s.text || !s.text.includes(value.term)) {
    ctx.addIssue({ code: "custom", message: "Preview content/selection does not match locator" });
  }
  if (value.context.expanded !== (l.start < s.start || l.end > s.end)) ctx.addIssue({ code: "custom", message: "Invalid context expansion state" });
  if (!matches(value.contextAnchor) || value.exposureReceipts.some(receipt => !matches(receipt.contextAnchor) || receipt.origin !== "material_excerpt" || receipt.releasedAt == null)) {
    ctx.addIssue({ code: "custom", message: "Preview anchor/receipt identity mismatch" });
  }
});
export type ConceptPreviewResponse = z.infer<typeof conceptPreviewResponseSchema>;
