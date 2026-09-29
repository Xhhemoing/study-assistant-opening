import { expect, it } from "vitest";
import { observationRevisionInputSchema } from "./learning-revisions";
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
