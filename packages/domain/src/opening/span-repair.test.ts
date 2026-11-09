import { describe, expect, it } from "vitest";
import type { SpanAnswer, SpanProblem } from "@aistudy/contracts";
import { buildSpanTargetedExplanation, chooseSpanRepairTeaching, diagnoseSpanRepair, spanRepairCheckMismatches } from "./span-repair";
import { verifySpanAnswer } from "./span-verifier";
import { listGeneratedSpanItems } from "./span-generated-items";
const teaching = listGeneratedSpanItems("teaching");

const problem: SpanProblem = { id: "test", version: "1", familyId: "span:consistent-3d",
  vectors: [["1", "0", "1"], ["0", "1", "1"]], target: ["1/2", "1/3", "5/6"], knowledgeComponents: ["span"] };
const correct: SpanAnswer = { membership: "in_span", coefficients: ["1/2", "1/3"],
  equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target };
const diagnose = (answer: SpanAnswer) => diagnoseSpanRepair(problem, answer, verifySpanAnswer(problem, answer));
describe("first verifiable operation dependency", () => {
  it("selects equation before downstream errors without inferring psychological cause", () => {
    expect(diagnose({ ...correct, equation: { vectors: problem.vectors, target: ["0", "0", "0"] }, coefficients: ["0", "0"] }))
      .toMatchObject({ status: "ready", targetSkill: "equation" });
  });
  it("requires an observed correct equation before targeting coefficients", () => {
    const { equation: _equation, ...unobserved } = correct;
    expect(diagnose({ ...unobserved, coefficients: ["0", "0"] })).toEqual({ status: "needs_clarification", reasonCode: "predecessor_unobserved" });
    expect(diagnose({ ...correct, coefficients: ["0", "0"] })).toMatchObject({ status: "ready", targetSkill: "coefficients" });
  });
  it("requires observed correct predecessors before targeting the third coordinate check", () => {
    const wrong = { ...correct, coordinateChecks: ["1/2", "1/3", "0"] };
    expect(diagnose(wrong)).toEqual({ status: "ready", targetSkill: "allCoordinates", checkMismatchCoordinates: [2] });
    expect(verifySpanAnswer(problem, wrong).failedCoordinates).toEqual([]);
    const { equation: _equation, ...missing } = wrong;
    expect(diagnose(missing)).toMatchObject({ status: "needs_clarification", reasonCode: "predecessor_unobserved" });
  });
  it("does not confuse failed target coordinates with student arithmetic mismatches", () => {
    const answer: SpanAnswer = { ...correct, coefficients: ["0", "0"], coordinateChecks: ["0", "0", "0"] };
    expect(verifySpanAnswer(problem, answer).failedCoordinates).toEqual([0, 1, 2]);
    expect(spanRepairCheckMismatches(problem, answer)).toEqual([]);
    expect(spanRepairCheckMismatches(problem, JSON.stringify({ ...correct, coordinateChecks: ["2/4", "2/6", "10/12"] }))).toEqual([]);
  });
  it("clarifies incomparable branch errors and rejects mismatched server skill claims", () => {
    expect(diagnose({ ...correct, coefficients: ["0", "0"], representations: { geometry: "line" } }))
      .toEqual({ status: "needs_clarification", reasonCode: "ambiguous_branch" });
    expect(diagnose({ ...correct, representations: { geometry: "line" } }))
      .toEqual({ status: "needs_clarification", reasonCode: "unsupported_target" });
    const wrong = { ...correct, coefficients: ["0", "0"] as [string, string] };
    expect(diagnoseSpanRepair(problem, wrong, verifySpanAnswer(problem, correct))).toMatchObject({ reasonCode: "verification_mismatch" });
    expect(diagnose({ ...correct, recognition: "uncertain" })).toMatchObject({ reasonCode: "evidence_unavailable" });
  });
});
describe("one-block exact teaching", () => {
  it("actually changes operations, not just a title; preserves third coordinate and exact fractions", () => {
    const equation = buildSpanTargetedExplanation(problem, "equation")!;
    const coefficients = buildSpanTargetedExplanation(problem, "coefficients")!;
    const checks = buildSpanTargetedExplanation(problem, "allCoordinates")!;
    expect(equation.workedSteps).toHaveLength(3);
    expect(equation.workedSteps[2]!.math).toContain("5/6");
    expect(coefficients.workedSteps[0]!.label).toBe("原增广矩阵");
    expect(coefficients.workedSteps.at(-1)!.math).toContain("1/2");
    expect(checks.workedSteps[2]!.math).toContain("= 5/6；目标 5/6");
    expect(equation.workedSteps).not.toEqual(coefficients.workedSteps);
    expect(checks.workedSteps).not.toEqual(equation.workedSteps);
    expect(buildSpanTargetedExplanation({ ...problem, target: ["bad"] }, "coefficients")).toBeNull();
  });
  it("selects two different unissued teaching identities in the original family and dimension", () => {
    const pair = chooseSpanRepairTeaching(problem, { contentKeys: new Set(), unknownHistory: false }, teaching)!;
    expect(pair.teachingExample.familyId).toBe(problem.familyId);
    expect(pair.practiceVariant.target).toHaveLength(3);
    expect(pair.teachingExample.id).toContain("-teaching-");
    expect(pair.practiceVariant.id).toContain("-teaching-");
    expect(pair.practiceVariant.id).not.toBe(pair.teachingExample.id);
    expect(chooseSpanRepairTeaching(problem, { contentKeys: new Set(), unknownHistory: true }, teaching)).toBeNull();
    expect(chooseSpanRepairTeaching({ ...problem, familyId: "unsupported" }, { contentKeys: new Set(), unknownHistory: false }, teaching)).toBeNull();
  });
});
