import { z } from "zod";
import { isoDateTimeSchema } from "./foundation";

export const loopMetricsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
}).strict();

export const loopMetricSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(160),
  unit: z.enum(["ratio", "count", "cents", "minutes", "milliseconds"]),
  value: z.number().finite().nonnegative().nullable(),
  numerator: z.number().finite().nonnegative().nullable(),
  denominator: z.number().finite().nonnegative().nullable(),
  sampleSize: z.number().int().nonnegative(),
  denominatorLabel: z.string().min(1).max(200),
  dataStatus: z.enum(["available", "no_samples", "not_collected", "unknown"]),
  excludedReasonCounts: z.record(z.string(), z.number().int().nonnegative()),
}).strict().superRefine((metric, ctx) => {
  if (metric.dataStatus !== "available" && metric.value !== null) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "Unavailable data cannot be represented as zero" });
  }
  if (metric.denominator === 0 && metric.unit === "ratio" && metric.value !== null) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "An empty denominator has no rate" });
  }
});

/** Every metric shares this half-open window and current-qualification snapshot. No overall score. */
export const loopMetricsReportSchema = z.object({
  metricVersion: z.literal("opening-loop-metrics-v1"),
  asOf: isoDateTimeSchema,
  windowStart: isoDateTimeSchema,
  windowEnd: isoDateTimeSchema,
  windowDays: z.number().int().min(1).max(90),
  timeZone: z.string().min(1).max(100),
  qualification: z.literal("current_heads_as_of_report"),
  groups: z.object({
    runtime: z.array(loopMetricSchema),
    learning: z.array(loopMetricSchema),
    burden: z.array(loopMetricSchema),
  }).strict(),
  notes: z.array(z.string().min(1).max(500)).max(12),
}).strict();

export type LoopMetric = z.infer<typeof loopMetricSchema>;
export type LoopMetricsReport = z.infer<typeof loopMetricsReportSchema>;
