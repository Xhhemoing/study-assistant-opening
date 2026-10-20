import { expect, it } from "vitest";
import { courseLearningHistoryInputSchema, courseLearningHistoryPageSchema } from "./learning-history";

const courseId = "11111111-1111-4111-8111-111111111111";
it("defaults to 50 and preserves all, unassigned, and empty requirement filters", () => {
  expect(courseLearningHistoryInputSchema.parse({ courseId })).toEqual({ courseId, limit: 50 });
  expect(courseLearningHistoryInputSchema.parse({ courseId, requirementKey: null }).requirementKey).toBeNull();
  expect(courseLearningHistoryInputSchema.parse({ courseId, requirementKey: "" }).requirementKey).toBe("");
  expect(courseLearningHistoryInputSchema.parse({ courseId, limit: 200 }).limit).toBe(200);
});
it.each([{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { extra: true }, { courseId: "bad" },
  { cursor: "" }, { cursor: "a".repeat(2049) }, { requirementKey: "a".repeat(201) }])("rejects invalid history inputs %o", (change) => {
  expect(courseLearningHistoryInputSchema.safeParse({ courseId, ...change }).success).toBe(false);
});
it("validates bounded pages and safe counters", () => {
  const page = { observations: [], snapshotRevision: 0, totalCount: 0, nextCursor: null, visibilityChanged: false };
  expect(courseLearningHistoryPageSchema.parse(page)).toEqual(page);
  for (const change of [{ snapshotRevision: -1 }, { snapshotRevision: Number.MAX_SAFE_INTEGER + 1 },
    { totalCount: 1.5 }, { totalCount: Number.MAX_SAFE_INTEGER + 1 }, { visibilityChanged: "false" }, { extra: true }]) {
    expect(courseLearningHistoryPageSchema.safeParse({ ...page, ...change }).success).toBe(false);
  }
});
it("permits 200 observations and rejects a 201-row response", () => {
  const observation = { id: courseId, workspaceId: courseId, sessionId: courseId, courseId, skillLabel: "fractions", sourceIds: [],
    answer: "1", outcome: "correct", assistance: "independent", clientKey: "history-record", occurredAt: "2026-09-30T00:00:00.000Z",
    sourceTurnIds: [], verdictSource: "self_report", referenceSourceId: null };
  const page = { snapshotRevision: 1, totalCount: 201, nextCursor: "cursor", visibilityChanged: false };
  expect(courseLearningHistoryPageSchema.safeParse({ ...page, observations: Array.from({ length: 200 }, () => observation) }).success).toBe(true);
  expect(courseLearningHistoryPageSchema.safeParse({ ...page, observations: Array.from({ length: 201 }, () => observation) }).success).toBe(false);
});
it("accepts validated release receipts without loosening the history response", () => {
  const receipt = { id: courseId, releaseKey: "history-release", contextAnchor: { purpose: "history_solution" }, origin: "history_solution", supportDomain: "unknown",
    generatedAt: "2026-10-19T00:00:00Z", releasedAt: "2026-10-19T00:00:00Z", acknowledgedAt: null, historyRevision: 1 };
  const page = { observations: [], snapshotRevision: 0, totalCount: 0, nextCursor: null, visibilityChanged: false, exposureReceipts: [receipt] };
  expect(courseLearningHistoryPageSchema.parse(page)).toEqual(page);
  expect(courseLearningHistoryPageSchema.safeParse({ ...page, exposureReceipts: [{ ...receipt, id: "invalid" }] }).success).toBe(false);
  expect(courseLearningHistoryPageSchema.safeParse({ ...page, exposureReceipts: Array(201).fill(receipt) }).success).toBe(false);
  expect(courseLearningHistoryPageSchema.safeParse({ ...page, extra: true }).success).toBe(false);
});
