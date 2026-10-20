import { expect, it } from "vitest";
import { evaluateTransferEligibility } from "./evidence-transfer-eligibility";
import { qualifiedInput } from "./learning-summary-fixtures";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
const eligibility = evaluateEvidenceEligibility(qualifiedInput.observation, qualifiedInput.context);
const specification = { fromFamilyId: "unique", familyId: "dependent", changes: ["dependent generators"], knowledgeComponents: ["span:vector-equation", "span:solve-coefficients", "span:check-all-coordinates", "geometry:plane-equation"] };
it("grants transfer only to the named verified KCs, leaving geometric explanations unverified", () => {
  const result = evaluateTransferEligibility({ specification, eligibility, baselineFamilyObservedBefore: true,
    evaluation: { ...qualifiedInput.context.serverEvaluation!, evaluatorVersion: "span-exact-v1", specVersion: "span-v1", coreEvidenceComplete: true,
      skills: { equation: "correct", coefficients: "correct", allCoordinates: "correct", geometry: "correct" } } });
  expect(result).toMatchObject({ usable: "yes", knowledgeComponents: ["span:vector-equation", "span:solve-coefficients", "span:check-all-coordinates"] });
  expect(result.reasonCodes).toContain("transfer_kc_unverified:geometry:plane-equation");
});
it("never turns a new item ID or a missing baseline into transfer evidence", () => {
  expect(evaluateTransferEligibility({ eligibility, baselineFamilyObservedBefore: true }).usable).toBe("unknown");
  expect(evaluateTransferEligibility({ specification, eligibility, baselineFamilyObservedBefore: false }).reasonCodes).toEqual(["transfer_baseline_not_established"]);
});
