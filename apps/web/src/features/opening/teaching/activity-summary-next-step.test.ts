import { expect, it } from "vitest";
import type { SnapshotObservation } from "@aistudy/domain";
import { activitySummaryNextStep } from "./activity-summary-next-step";

const independent: SnapshotObservation = {
  id: "11111111-1111-4111-8111-111111111111", skillLabel: "矩阵",
  attemptedAt: "2026-11-19T10:00:00Z", assistance: "independent",
  independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes",
};

it.each(["hinted", "revealed"] as const)("prompts an independent check following a verified %s answer", assistance => {
  const helped = { ...independent, id: "22222222-2222-4222-8222-222222222222", assistance,
    independentAttempt: "no" as const, attemptedAt: "2026-11-19T11:00:00Z" };
  expect(activitySummaryNextStep([independent, helped])).toEqual({ kind: "assisted_check", observationId: helped.id });
});

it("offers a delayed retest only for verified independent success", () => {
  expect(activitySummaryNextStep([independent])).toEqual({ kind: "schedule_retest", observationId: independent.id });
  expect(activitySummaryNextStep([{ ...independent, verifiedCorrect: "unknown" }])).toBeUndefined();
  expect(activitySummaryNextStep([{ ...independent, independentAttempt: "unknown" }])).toBeUndefined();
  expect(activitySummaryNextStep([{ ...independent, usableForCurrentVersion: "no" }])).toBeUndefined();
});
