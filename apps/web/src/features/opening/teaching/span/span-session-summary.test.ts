import { expect, it } from "vitest";
import type { LearningObservation } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { learningObservation, qualifiedInput } from "../../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { summarizeSpanSession } from "./span-session-summary";

it("summarizes current server facts without merging hinted, obsolete or retracted work into independence", () => {
  const eligibility = evaluateEvidenceEligibility(qualifiedInput.observation, qualifiedInput.context);
  const independent = { ...learningObservation, id: "original", eligibility, serverEvaluation: { decision: "correct" } } as LearningObservation;
  const hinted = { ...independent, id: "hinted", assistance: "hinted", eligibility: { ...eligibility, independentAttempt: "no" } } as LearningObservation;
  const unknown = { ...independent, id: "unknown", eligibility: undefined, serverEvaluation: { decision: "abstain" } } as LearningObservation;
  const result = summarizeSpanSession([independent, hinted, unknown, { ...independent, id: "old", effectiveHeadId: "new" }, { ...independent, id: "withdrawn", revisionKind: "retract" }]);
  expect(result).toMatchObject({ recorded: 3, independent: 1, helped: 1, needsCheck: 1 });
  expect(result.observations.map(row => row.id)).toEqual(["original", "hinted", "unknown"]);
  expect(summarizeSpanSession([])).toMatchObject({ recorded: 0, independent: 0, helped: 0, needsCheck: 0 });
});
