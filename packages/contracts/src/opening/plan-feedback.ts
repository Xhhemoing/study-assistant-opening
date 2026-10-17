import { z } from "zod";
import { isoDateTimeSchema } from "./foundation";

/** Counts of recorded planning actions, not task completion rates or learning gains. */
export const planFeedbackSummarySchema = z.object({
  from: isoDateTimeSchema,
  until: isoDateTimeSchema,
  actions: z.object({
    done: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
    resumed: z.number().int().nonnegative(),
  }).strict(),
  /** Skip/defer actions with an optional reason, excluding explicit non-disclosure. */
  reasons: z.object({
    eligible: z.number().int().nonnegative(),
    supplied: z.number().int().nonnegative(),
    declined: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    coverage: z.number().min(0).max(1).nullable(),
    counts: z.object({
      time_short: z.number().int().nonnegative(),
      too_hard: z.number().int().nonnegative(),
      too_easy: z.number().int().nonnegative(),
      not_relevant: z.number().int().nonnegative(),
      other: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  /** Historical actions were not logged; they must remain unknown. */
  historicalActions: z.literal("unknown"),
}).strict();

export type PlanFeedbackSummary = z.infer<typeof planFeedbackSummarySchema>;
