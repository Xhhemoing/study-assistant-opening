import { expect, it } from "vitest";
import { loopMetricSchema, loopMetricsQuerySchema } from "./loop-metrics";

it("defaults to seven days and rejects fractional, unbounded and extra inputs", () => {
  expect(loopMetricsQuerySchema.parse({})).toEqual({ days: 7 });
  for (const days of ["0", "91", "1.5", "NaN", ""]) expect(loopMetricsQuerySchema.safeParse({ days }).success).toBe(false);
  expect(loopMetricsQuerySchema.safeParse({ days: "90" }).success).toBe(true);
  expect(loopMetricsQuerySchema.safeParse({ days: 7, ownerUserId: "spoof" }).success).toBe(false);
});

it("rejects fabricated zeros for missing data and zero-denominator rates", () => {
  const metric = { id: "example", label: "例", unit: "ratio", value: null, numerator: 0, denominator: 0,
    sampleSize: 0, denominatorLabel: "当前样本", dataStatus: "no_samples", excludedReasonCounts: {} };
  expect(loopMetricSchema.safeParse(metric).success).toBe(true);
  expect(loopMetricSchema.safeParse({ ...metric, value: 0 }).success).toBe(false);
  expect(loopMetricSchema.safeParse({ ...metric, value: 0, dataStatus: "available" }).success).toBe(false);
});
