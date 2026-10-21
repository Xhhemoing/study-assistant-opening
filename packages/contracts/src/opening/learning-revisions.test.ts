import { expect, it } from "vitest";
import { observationHistorySchema, observationRevisionInputSchema } from "./learning-revisions";
const id = "11111111-1111-4111-8111-111111111111";
const base = { rootObservationId: id, revisesObservationId: id, expectedHead: id, reason: "Correct transcription", clientKey: "revision-001" };
const replacement = { answer: "1", outcome: "correct", assistance: "independent" };
it("requires replacement only for replace and a nonblank audit reason", () => {
  expect(observationRevisionInputSchema.safeParse({ ...base, revisionKind: "replace", replacement }).success).toBe(true);
  expect(observationRevisionInputSchema.safeParse({ ...base, revisionKind: "retract" }).success).toBe(true);
  expect(observationRevisionInputSchema.safeParse({ ...base, revisionKind: "replace" }).success).toBe(false);
  expect(observationRevisionInputSchema.safeParse({ ...base, revisionKind: "retract", replacement }).success).toBe(false);
  expect(observationRevisionInputSchema.safeParse({ ...base, revisionKind: "retract", reason: "   " }).success).toBe(false);
});
it.each(["actorId", "historyRevision", "recordedAt", "eligibility"])("rejects client derived operation field %s", (key) => {
  expect(observationRevisionInputSchema.safeParse({ ...base, revisionKind: "retract", [key]: id }).success).toBe(false);
});
it.each(["attemptId", "sessionId", "problemId", "itemVersionId", "sourceIds", "sourceVersions", "startedAt", "submittedAt", "eligibility"])("rejects replacement of captured fact %s", (key) => {
  expect(observationRevisionInputSchema.safeParse({ ...base, revisionKind: "replace", replacement: { ...replacement, [key]: id } }).success).toBe(false);
});
it("permits explicit attribution correction without changing root identity", () => {
  expect(observationRevisionInputSchema.safeParse({ ...base, revisionKind: "replace", replacement: { ...replacement, courseId: id, skillLabel: "fractions", requirementKey: null } }).success).toBe(true);
});

it("accepts typed HTTP history receipts while preserving repository-only history", () => {
  const history = { rootObservationId: id, headObservationId: id, revisions: [] };
  const receipt = { id, releaseKey: "history-release", contextAnchor: { purpose: "history_solution" }, origin: "history_solution", supportDomain: "unknown",
    generatedAt: "2026-10-21T00:00:00Z", releasedAt: "2026-10-21T00:00:00Z", acknowledgedAt: null, historyRevision: 1 };
  expect(observationHistorySchema.parse(history)).toEqual(history);
  expect(observationHistorySchema.parse({ ...history, exposureReceipts: [receipt] })).toEqual({ ...history, exposureReceipts: [receipt] });
  expect(observationHistorySchema.safeParse({ ...history, exposureReceipts: [{ ...receipt, id: "invalid" }] }).success).toBe(false);
  expect(observationHistorySchema.safeParse({ ...history, exposureReceipts: [{ ...receipt, extra: true }] }).success).toBe(false);
  expect(observationHistorySchema.safeParse({ ...history, exposureReceipts: [receipt], extra: true }).success).toBe(false);
});

it("preserves a complete revision history beyond the separate paginated course-history limit", () => {
  const revisions = Array.from({ length: 201 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`, workspaceId: id, sessionId: id, courseId: id,
    skillLabel: "fractions", sourceIds: [], answer: String(index), outcome: "correct", assistance: "hinted", clientKey: `history-record-${index}`,
    occurredAt: "2026-10-21T00:00:00Z", sourceTurnIds: [], verdictSource: "self_report", referenceSourceId: null, evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
  }));
  const exposureReceipts = revisions.map((revision, index) => ({ id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    releaseKey: `history-release:history_solution:${index}`, contextAnchor: { purpose: "history_solution" }, origin: "history_solution", supportDomain: "unknown",
    generatedAt: revision.occurredAt, releasedAt: revision.occurredAt, acknowledgedAt: null, historyRevision: index + 1 }));
  const history = { rootObservationId: revisions[0]!.id, headObservationId: revisions[200]!.id, revisions, exposureReceipts };
  expect(observationHistorySchema.parse(history)).toEqual(history);
});
