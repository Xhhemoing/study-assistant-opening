import { expect, it } from "vitest";
import { readSpanDraftAnswer, spanVectorInput, updateSpanDraftAnswer } from "./span-answer";
it("preserves manually entered steps and never fills an equation from question operands", () => {
  const raw = updateSpanDraftAnswer("", { coefficients: ["-1/2", "2"], membership: "in_span" });
  expect(readSpanDraftAnswer(raw)).toEqual({ recognition: "confirmed", membership: "in_span", coefficients: ["-1/2", "2"] });
  expect(readSpanDraftAnswer(raw).equation).toBeUndefined();
  expect(readSpanDraftAnswer(raw).coordinateChecks).toBeUndefined();
  expect(spanVectorInput(" 1/2，-2, 0 ")).toEqual(["1/2", "-2", "0"]);
  expect(readSpanDraftAnswer("not JSON")).toEqual({});
});
it("keeps the learner's no-solution proof and representation choices with the first answer", () => {
  const raw = updateSpanDraftAnswer("", { membership: "not_in_span", coefficients: ["2", "2"], coordinateChecks: ["2", "4", "2"],
    coefficientDerivationCoordinates: [0, 2], representations: { system: "none", geometry: "plane" } });
  expect(readSpanDraftAnswer(raw)).toMatchObject({ coefficientDerivationCoordinates: [0, 2], representations: { system: "none", geometry: "plane" } });
});
