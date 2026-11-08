import { describe, expect, it } from "vitest";
import { examQuestionPartsSchema } from "./exam-integration";
const id = "11111111-1111-4111-8111-111111111111";
const snapshot = { questionIdentityRefId: id, packId: "pack", packVersion: "1", questionId: "q", familyId: "f",
  parts: [{ partId: "a", identityRefId: id, requirementKey: "requirement-a", evaluator: { kind: "choice-options-v1", correctOptionIds: ["a"] } },
    { partId: "b", identityRefId: id, requirementKey: "requirement-b" }] };
describe("private exam part snapshot shape (not authority)", () => {
  it("preserves stable refs and accepts missing rules without inventing a result", () => {
    expect(examQuestionPartsSchema.parse(snapshot)).toEqual(snapshot);
    expect(examQuestionPartsSchema.parse({ ...snapshot, parts: [...snapshot.parts].reverse() }).parts[0]?.partId).toBe("b");
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
