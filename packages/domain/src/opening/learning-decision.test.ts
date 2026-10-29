import { expect, it } from "vitest";
import { learningDecisionInvalidation, validateLearningDecision, type LearningDecisionInput } from "./learning-decision";
const receipt: LearningDecisionInput = { layer: "session", targetId: "session", stateVersion: "state1", goalVersion: "goal1", intentVersion: "intent1", policyVersion: "policy1",
  candidates: [{ action: "independent_probe", eligible: true, reasonCodes: ["retention_gap"], evidenceRefs: ["attempt:a"] }], selectedAction: "independent_probe",
  reasonCodes: ["retention_gap"], evidenceRefs: ["attempt:a"], sourceVersions: { material: [1] }, dataAsOf: "2026-10-19T00:00:00Z",
  invalidationConditions: ["state_changed", "goal_changed", "intent_changed", "policy_changed", "source_changed"] };
it("revalidates each captured input separately", () => {
  expect(learningDecisionInvalidation(receipt, { ...receipt })).toEqual([]);
  expect(learningDecisionInvalidation(receipt, { ...receipt, stateVersion: "state2", sourceVersions: { material: [2] } })).toEqual(["state_changed", "source_changed"]);
});
it("rejects an excluded candidate or a plan with a parent", () => {
  expect(() => validateLearningDecision({ ...receipt, selectedAction: "show_answer" })).toThrow(/eligible/);
  expect(() => validateLearningDecision({ ...receipt, layer: "plan", parentDecisionId: "parent" })).toThrow(/parent/);
});
it("accepts zero and positive integer source versions without dropping zero", () => {
  const input = { ...receipt, sourceVersions: { material: [0, 1] } };
  expect(() => validateLearningDecision(input)).not.toThrow();
  expect(input.sourceVersions).toEqual({ material: [0, 1] });
});
it.each([-1, 0.5, NaN, Infinity])("rejects invalid source version %s", version => {
  expect(() => validateLearningDecision({ ...receipt, sourceVersions: { material: [version] } })).toThrow(/Decision requires/);
});
