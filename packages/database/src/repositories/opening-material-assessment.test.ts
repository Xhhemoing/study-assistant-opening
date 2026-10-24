import { expect, it } from "vitest";
import type { AiEvaluation, AiGradingMaterialProvenance } from "@aistudy/contracts";
import { assertOpeningMaterialProvenance, captureOpeningMaterialProvenance, openingMaterialAssessmentValidity, type OpeningMaterialAssessmentState } from "./opening-material-assessment";

const question = "00000000-0000-4000-8000-000000000001", answer = "00000000-0000-4000-8000-000000000002";
const state: OpeningMaterialAssessmentState = {
  materialSourceRefs: [{ sourceId: question, sourceVersion: 0, manifestRevision: 1 }, { sourceId: answer, sourceVersion: 1, manifestRevision: 2 }],
  materialAnswerRefs: [{ sourceId: answer, sourceVersion: 1, manifestRevision: 2 }], disputed: false,
};
const assessment = (provenance: Partial<AiGradingMaterialProvenance> = {}) => ({ ...provenance }) as AiEvaluation;

it("captures complete dependencies as a detached value and compares both reverse links and source revisions", () => {
  const live = structuredClone(state), captured = captureOpeningMaterialProvenance(live);
  expect(openingMaterialAssessmentValidity(assessment(captured), live)).toBe("current");
  live.materialSourceRefs[0]!.manifestRevision = 3;
  expect(captured.materialSourceRefs[0]!.manifestRevision).toBe(1);
  expect(openingMaterialAssessmentValidity(assessment(captured), live)).toBe("changed");
  expect(() => assertOpeningMaterialProvenance(captured, captureOpeningMaterialProvenance(live))).toThrow("修订");
  expect(openingMaterialAssessmentValidity(assessment(captured), { ...state, materialAnswerRefs: [] })).toBe("changed");
  expect(openingMaterialAssessmentValidity(assessment({ materialSourceRefs: captured.materialSourceRefs, materialAnswerRefs: [] }), state)).toBe("changed");
});

it("never backfills historical provenance from today's classified reference", () => {
  expect(openingMaterialAssessmentValidity(assessment(), state)).toBe("unknown");
  expect(openingMaterialAssessmentValidity(assessment({ materialSourceRefs: state.materialSourceRefs as AiGradingMaterialProvenance["materialSourceRefs"] }), state)).toBe("unknown");
  expect(openingMaterialAssessmentValidity(assessment(), { materialSourceRefs: [{ sourceId: question, sourceVersion: 0, manifestRevision: 0 }], materialAnswerRefs: [], disputed: false })).toBe("current");
  expect(openingMaterialAssessmentValidity(null, state)).toBe("current");
});

it("rejects missing/unreadable dependencies at capture rather than inventing a manifest revision", () => {
  expect(() => captureOpeningMaterialProvenance({ ...state, materialSourceRefs: [{ sourceId: question, sourceVersion: null, manifestRevision: null }] })).toThrow();
  expect(openingMaterialAssessmentValidity(assessment(captureOpeningMaterialProvenance(state)), {
    ...state, materialSourceRefs: [{ sourceId: question, sourceVersion: null, manifestRevision: null }],
  })).toBe("changed");
});
