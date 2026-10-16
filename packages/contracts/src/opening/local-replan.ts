import { z } from "zod";
import { calendarDateSchema, isoDateTimeSchema, uuidSchema } from "./foundation";
import { plannedBlockSchema, planDraftSchema, timeBlockSchema } from "./planning";

export const localReplanExplicitFreeSchema = z.array(timeBlockSchema).min(1).max(200).superRefine((blocks, ctx) => {
  if (blocks.some(block => Date.parse(block.start) >= Date.parse(block.end))) ctx.addIssue({ code: "custom", message: "Planning windows must have positive duration" });
});

export const localReplanInputSchema = z.object({
  date: calendarDateSchema,
  expectedAcceptedVersion: z.number().int().nonnegative(),
  clientKey: z.string().min(8).max(200),
}).strict();
export const localReplanMetadataSchema = z.object({
  kind: z.literal("local_replan_v1"),
  baseAcceptedVersion: z.number().int().nonnegative(),
  baselineBlocks: z.array(plannedBlockSchema).max(200),
  fixedBlocks: z.array(plannedBlockSchema).max(200),
  releasedTaskVersions: z.array(z.object({
    id: uuidSchema, version: z.number().int().positive(),
    status: z.enum(["pending", "done", "skipped"]),
  }).strict()).max(200),
  proposedAt: isoDateTimeSchema,
  preserveAll: z.boolean(),
  /** Internal source-revision adapter's explicit manual windows; hard constraints are re-read on accept. */
  explicitFree: localReplanExplicitFreeSchema.optional(),
}).strict();
export const localReplanResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_change") }).strict(),
  z.object({ kind: z.literal("draft"), draft: planDraftSchema }).strict(),
]);
export const replanOfferSchema = z.object({
  dismissalKey: z.string().max(300).optional(),
  offer: z.boolean(), taskIds: z.array(uuidSchema).max(200),
  reason: z.enum(["missed_block", "freed_time"]).nullable(),
}).strict();
export type LocalReplanInput = z.infer<typeof localReplanInputSchema>;
export type LocalReplanMetadata = z.infer<typeof localReplanMetadataSchema>;
export type LocalReplanResult = z.infer<typeof localReplanResultSchema>;
