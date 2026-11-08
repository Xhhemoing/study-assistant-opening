import { describe, expect, it } from "vitest";
import { examQuestionPartsSchema } from "./exam-integration";
import { teachingLearnerFocusSchema } from "./teaching-activity";
const id = "11111111-1111-4111-8111-111111111111";
const snapshot = { questionIdentityRefId: id, packId: "pack", packVersion: "1", questionId: "q", familyId: "f",
  parts: [{ partId: "a", identityRefId: id, requirementKey: "requirement-a", evaluator: { kind: "choice-options-v1", correctOptionIds: ["a"] } },
    { partId: "b", identityRefId: id, requirementKey: "requirement-b" }] };
describe("private exam part snapshot shape (not authority)", () => {
  it("preserves stable refs and accepts missing rules without inventing a result", () => {
    expect(examQuestionPartsSchema.parse(snapshot)).toEqual(snapshot);
    expect(examQuestionPartsSchema.parse({ ...snapshot, parts: [...snapshot.parts].reverse() }).parts[0]?.partId).toBe("b");
  });
  it("keeps legacy focus shape absent and validates every private part focus ref", () => {
    const legacy = { skillLabel: "skill", requirementKey: "requirement-a", activityKind: "targeted_explain", reasonCode: "verified_incorrect",
      focusObservationId: id, recentAssistance: [], strategyVersion: "course-route-1" };
    expect(teachingLearnerFocusSchema.parse(legacy)).toEqual(legacy);
    const examPartFocus = { questionIdentityRefId: id, partId: "a", identityRefId: id, requirementKey: "requirement-a" };
    expect(teachingLearnerFocusSchema.parse({ ...legacy, examPartFocus }).examPartFocus).toEqual(examPartFocus);
    for (const field of ["questionIdentityRefId", "partId", "identityRefId", "requirementKey"] as const) {
      const { [field]: _missing, ...incomplete } = examPartFocus;
      expect(teachingLearnerFocusSchema.safeParse({ ...legacy, examPartFocus: incomplete }).success).toBe(false);
    }
    expect(teachingLearnerFocusSchema.safeParse({ ...legacy, examPartFocus: { ...examPartFocus, outcome: "incorrect" } }).success).toBe(false);
  });
  it("rejects duplicates and unknown server fields", () => {
    for (const invalid of [{ ...snapshot, parts: [snapshot.parts[0], snapshot.parts[0]] },
      { ...snapshot, parts: [] }, { ...snapshot, outcome: "correct" },
      { ...snapshot, parts: [{ ...snapshot.parts[0], outcome: "correct" }] },
      { ...snapshot, parts: [{ ...snapshot.parts[0], evaluator: { kind: "choice-options-v1", correctOptionIds: ["a", "a"] } }] }]) {
      expect(examQuestionPartsSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
