import { describe, expect, it } from "vitest";
import { evidenceEligibilitySchema } from "./learning-evidence";
import { studyExposureReceiptSchema } from "./tutor";

const policies = ["opening-evidence-v1", "opening-evidence-v2", "opening-evidence-v3"] as const;
const qualification = { independentAttempt: "no", verifiedCorrect: "yes", usableForCurrentVersion: "yes",
  usableForDelayedCheck: "no", reasonCodes: ["help_before_submission"], policyVersion: policies[0] };
const keys = ["independentAttempt", "verifiedCorrect", "usableForCurrentVersion", "usableForDelayedCheck"] as const;
describe("captured qualification receipts are historical facts, not a recomputation", () => {
  it.each(policies.flatMap(policyVersion => (["yes", "no", "unknown"] as const).map(independentAttempt => ({ policyVersion, independentAttempt })) ))(
    "preserves $policyVersion / $independentAttempt exactly", ({ policyVersion, independentAttempt }) => {
      const raw = { ...qualification, policyVersion, independentAttempt };
      expect(evidenceEligibilitySchema.parse(raw)).toEqual(raw);
      expect(raw.reasonCodes).toEqual(["help_before_submission"]);
    });
  it.each(keys.flatMap(key => [null, true, false, 0, "true"].map(value => ({ key, value }))))(
    "rejects $key=$value rather than coercing tri-state qualification", ({ key, value }) => {
      expect(evidenceEligibilitySchema.safeParse({ ...qualification, [key]: value }).success).toBe(false);
    });
  it.each([null, true, false, "opening-evidence-v0", "opening-evidence-v5"])("rejects unknown policy %s", policyVersion => {
    expect(evidenceEligibilitySchema.safeParse({ ...qualification, policyVersion }).success).toBe(false);
  });
  it("does not accept a client-invented mastery flag or silently strip it", () => {
    expect(evidenceEligibilitySchema.safeParse({ ...qualification, mastered: true }).success).toBe(false);
  });
});

const id = "10000000-0000-4000-8000-000000000001";
const receipt = { id, releaseKey: "fixture-receipt-001", contextAnchor: { purpose: "learning_help", attemptId: id },
  origin: "assistant", supportDomain: "unknown", generatedAt: "2026-11-06T00:00:00Z", releasedAt: "2026-11-06T00:00:00Z",
  acknowledgedAt: null, historyRevision: 3 };
describe("delivery receipt shape does not invent an ACK or help level", () => {
  it.each([null, "2026-11-06T00:01:00Z"])("preserves actual ACK %s", acknowledgedAt => {
    expect(studyExposureReceiptSchema.parse({ ...receipt, acknowledgedAt })).toEqual({ ...receipt, acknowledgedAt });
  });
  it.each([null, "2026-11-06T00:00:00Z"])("preserves actual release %s", releasedAt => {
    expect(studyExposureReceiptSchema.parse({ ...receipt, releasedAt })).toEqual({ ...receipt, releasedAt });
  });
  it.each([
    { label: "boolean ACK", patch: { acknowledgedAt: true } },
    { label: "boolean release", patch: { releasedAt: false } },
    { label: "boolean revision", patch: { historyRevision: true } },
    { label: "null revision", patch: { historyRevision: null } },
    { label: "boolean attempt", patch: { contextAnchor: { purpose: "learning_help", attemptId: true } } },
    { label: "boolean hint stage", patch: { hintStage: true } },
    { label: "fake independent authority", patch: { independentAttempt: "yes" } },
  ])("rejects $label", ({ patch }) => {
    expect(studyExposureReceiptSchema.safeParse({ ...receipt, ...patch }).success).toBe(false);
  });
});
