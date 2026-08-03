import { z } from "zod";

export const statusWordSchema = z.enum(["stable", "usable", "weak", "untested"]);

export const summaryMetricSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
});

export const recommendedActionSchema = z.object({
  code: z.string(),
  label: z.string(),
  estimatedMinutes: z.number().int().positive(),
});

export const statusResultSchema = z.object({
  syllabusPointId: z.string().uuid(),
  status: statusWordSchema,
  summaryMetrics: z.array(summaryMetricSchema).max(3),
  reasonCodes: z.array(z.string()).max(3),
  recommendedActions: z.array(recommendedActionSchema).min(1).max(3),
  evidenceSnapshotId: z.string().min(1),
  strategyVersion: z.string().min(1),
  modelVersion: z.string().min(1),
  computedAt: z.string().datetime(),
});

export type StatusWord = z.infer<typeof statusWordSchema>;
export type SummaryMetric = z.infer<typeof summaryMetricSchema>;
export type RecommendedAction = z.infer<typeof recommendedActionSchema>;
export type StatusResult = z.infer<typeof statusResultSchema>;
