import { describe, expect, it } from "vitest";
import { courseLearningSummaryInputSchema, courseLearningSummaryPageSchema, learningSummaryAggregateSchema } from "./learning-summary-page";

const courseId = "11111111-1111-4111-8111-111111111111";
const observationId = "22222222-2222-4222-8222-222222222222";
const rootId = "33333333-3333-4333-8333-333333333333";
const evaluatedAt = "2026-09-30T12:00:00.000Z";
const attemptAt = Date.parse(evaluatedAt);
const representative = {
  observationId, rootId, attemptAt, versionApplicability: "exact",
  eligibility: { independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown",
    reasonCodes: ["reference_checked_correct"], policyVersion: "opening-evidence-v1" },
};
const aggregate = {
  identity: { courseId, requirementKey: "requirement-1", skillLabel: "fractions" },
  sampleCount: 201, lastObservedAt: evaluatedAt, latestAttemptAt: attemptAt, latestAttemptCount: 201,
  independentVerifiedCurrentCount: 201, latestIndependentVerifiedCurrentCount: 201, historicalIncorrectCount: 0,
  historicalSuccessCount: 0, applicabilityCounts: { exact: 201, equivalent_confirmed: 0, changed_needs_check: 0, version_unknown: 0, unavailable: 0 },
  unverifiedCount: 0, evidenceSources: ["reference_checked"], representatives: [representative],
  openChecks: { acceptedCount: 1, inProgressCount: 1, dueCount: 1 },
};
const page = { status: "ready", groups: [aggregate], snapshotRevision: 7, nextCursor: null, evaluatedAt, pendingProjectionCount: 0 };

describe("course learning summary input", () => {
  it("defaults to ten groups and preserves an opaque cursor", () => {
    expect(courseLearningSummaryInputSchema.parse({ courseId })).toEqual({ courseId, limit: 10 });
    expect(courseLearningSummaryInputSchema.parse({ courseId, groupCursor: "opaque+/= value", limit: 50 })).toEqual({ courseId, groupCursor: "opaque+/= value", limit: 50 });
  });
  it.each([{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { groupCursor: "" }, { ownerUserId: rootId }, { courseId: "invalid" }])("rejects invalid boundary input %j", fields => {
    expect(courseLearningSummaryInputSchema.safeParse({ courseId, ...fields }).success).toBe(false);
  });
});

describe("complete group aggregates with bounded representatives", () => {
  it("keeps full counts independently of the representative count", () => {
    expect(learningSummaryAggregateSchema.parse(aggregate)).toEqual(aggregate);
  });
  it("preserves null and empty requirement identities as distinct groups", () => {
    const nullGroup = learningSummaryAggregateSchema.parse({ ...aggregate, identity: { ...aggregate.identity, requirementKey: null } });
    const emptyGroup = learningSummaryAggregateSchema.parse({ ...aggregate, identity: { ...aggregate.identity, requirementKey: "" } });
    expect(nullGroup.identity.requirementKey).toBeNull();
    expect(emptyGroup.identity.requirementKey).toBe("");
    expect(JSON.stringify(nullGroup.identity)).not.toBe(JSON.stringify(emptyGroup.identity));
  });
  it("allows visible native checks without observations or invented ability evidence", () => {
    const group = { ...aggregate, sampleCount: 0, lastObservedAt: null, latestAttemptAt: null, latestAttemptCount: 0,
      independentVerifiedCurrentCount: 0, latestIndependentVerifiedCurrentCount: 0, historicalIncorrectCount: 0, unverifiedCount: 0,
      historicalSuccessCount: 0, applicabilityCounts: { exact: 0, equivalent_confirmed: 0, changed_needs_check: 0, version_unknown: 0, unavailable: 0 },
      evidenceSources: [], representatives: [], openChecks: { acceptedCount: 1, inProgressCount: 0, dueCount: 0 } };
    expect(learningSummaryAggregateSchema.parse(group)).toEqual(group);
  });
  it.each([
    { status: "mastered" }, { sampleCount: -1 }, { unverifiedCount: 202 }, { latestAttemptCount: 202 }, { latestIndependentVerifiedCurrentCount: 202 },
    { independentVerifiedCurrentCount: 200 }, { historicalIncorrectCount: 1 }, { historicalSuccessCount: 1 },
    { applicabilityCounts: { exact: 200, equivalent_confirmed: 0, changed_needs_check: 0, version_unknown: 0, unavailable: 0 } }, { latestAttemptAt: evaluatedAt },
    { openChecks: { acceptedCount: 1, inProgressCount: 0, dueCount: 2 } },
    { representatives: Array.from({ length: 21 }, (_, index) => ({ ...representative,
      observationId: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`, rootId: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}` })) },
    { representatives: [{ ...representative, attemptAt: evaluatedAt }] },
    { representatives: [{ ...representative, answer: "private answer" }] },
    { representatives: [{ ...representative, eligibility: { ...representative.eligibility, verifiedCorrect: "mastered" } }] },
  ])("rejects inconsistent counts, oversized or malformed representatives %j", fields => {
    expect(learningSummaryAggregateSchema.safeParse({ ...aggregate, ...fields }).success).toBe(false);
  });
});

describe("course learning summary page calculation state", () => {
  it("accepts a ready page and a genuine empty ready page", () => {
    expect(courseLearningSummaryPageSchema.parse(page)).toEqual(page);
    expect(courseLearningSummaryPageSchema.parse({ ...page, groups: [] }).groups).toEqual([]);
  });
  it("reports repair progress without carrying old or partial group conclusions", () => {
    const updating = { ...page, status: "updating", groups: [], pendingProjectionCount: 4, nextCursor: "same-group-page-repair-cursor" };
    expect(courseLearningSummaryPageSchema.parse(updating)).toEqual(updating);
    expect(courseLearningSummaryPageSchema.safeParse({ ...updating, groups: [aggregate] }).success).toBe(false);
  });
  it.each([
    { pendingProjectionCount: 1 }, { status: "updating", groups: [], pendingProjectionCount: 0 },
    { snapshotRevision: -1 }, { snapshotRevision: Number.MAX_SAFE_INTEGER + 1 }, { evaluatedAt: "invalid" },
    { nextCursor: "" }, { groups: Array.from({ length: 51 }, () => aggregate) },
  ])("rejects inconsistent state or malformed page metadata %j", fields => {
    expect(courseLearningSummaryPageSchema.safeParse({ ...page, ...fields }).success).toBe(false);
  });
});

it("accepts an opaque cursor carrying long UTF-8 group identities within the bounded transport size", () => {
  const cursor = "a".repeat(4096);
  expect(courseLearningSummaryInputSchema.parse({ courseId, groupCursor: cursor }).groupCursor).toBe(cursor);
  expect(courseLearningSummaryPageSchema.parse({ ...page, nextCursor: cursor }).nextCursor).toBe(cursor);
  expect(courseLearningSummaryInputSchema.safeParse({ courseId, groupCursor: cursor + "a" }).success).toBe(false);
});