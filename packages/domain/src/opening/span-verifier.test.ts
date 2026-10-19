import { describe, expect, it } from "vitest";
import type { SpanProblem } from "@aistudy/contracts";
import { solveSpanProblem, verifySpanAnswer } from "./span-verifier";
import { parseSpanRational, formatSpanRational } from "./span-rational";
const problem = (vectors: [string[], string[]], target: string[]): SpanProblem => ({ id: "test", version: "1", familyId: "fixture", vectors, target, knowledgeComponents: ["span:solve-coefficients"] });
const p = problem([["1", "0", "1"], ["0", "1", "1"]], ["1/2", "-2/3", "-1/6"]);
describe("exact span verification", () => {
  it("solves fractions and negatives with no floating point loss", () => {
    expect(solveSpanProblem(p)).toEqual({ kind: "unique", coefficients: ["1/2", "-2/3"] });
    expect(verifySpanAnswer(p, { membership: "in_span", coefficients: ["2/4", "-4/6"], coordinateChecks: ["0.5", "-2/3", "-1/6"], equation: { vectors: p.vectors, target: p.target } })).toMatchObject({ outcome: "correct", skills: { equation: "correct", coefficients: "correct", allCoordinates: "correct" } });
  });
  it("accepts every valid coefficient pair for dependent generators", () => {
    const dependent = problem([["1", "2"], ["2", "4"]], ["3", "6"]);
    expect(solveSpanProblem(dependent)).toEqual({ kind: "infinite", particular: ["3", "0"], directions: [["-2", "1"]] });
    for (const coefficients of [["3", "0"], ["1", "1"], ["-1", "2"], ["1/3", "4/3"]]) expect(verifySpanAnswer(dependent, { membership: "in_span", coefficients }).outcome).toBe("correct");
  });
  it("handles zero generators and two-dimensional null space", () => {
    const zero = problem([["0", "0"], ["0", "0"]], ["0", "0"]);
    expect(solveSpanProblem(zero)).toMatchObject({ kind: "infinite", directions: [["1", "0"], ["0", "1"]] });
    expect(verifySpanAnswer(zero, { membership: "in_span", coefficients: ["-100", "2/7"] }).outcome).toBe("correct");
    expect(solveSpanProblem(problem([["0"], ["0"]], ["1"]))).toEqual({ kind: "none" });
  });
  it("checks the third coordinate, rather than accepting a two-coordinate solution", () => {
    const noSolution = problem([["1", "0", "1"], ["0", "1", "1"]], ["1", "2", "4"]);
    expect(verifySpanAnswer(noSolution, { membership: "in_span", coefficients: ["1", "2"] })).toMatchObject({ outcome: "incorrect", failedCoordinates: [2], countsAsStudentError: true });
    expect(verifySpanAnswer(noSolution, { membership: "not_in_span" })).toMatchObject({ outcome: "unknown", membershipOutcome: "correct", coreEvidenceComplete: false, countsAsStudentError: false });
    expect(verifySpanAnswer(noSolution, { membership: "not_in_span", noSolutionWitness: ["-1", "-1", "1"] }).outcome).toBe("correct");
    expect(verifySpanAnswer(p, { membership: "not_in_span" }).outcome).toBe("incorrect");
  });
  it("verifies a no-solution derivation and rejects arbitrary failed coefficients", () => {
    const noSolution = problem([["1", "0", "1"], ["0", "1", "1"]], ["1", "2", "4"]);
    const derivation = { membership: "not_in_span", coefficients: ["1", "2"], coefficientDerivationCoordinates: [0, 1], coordinateChecks: ["1", "2", "3"], equation: { vectors: noSolution.vectors, target: noSolution.target } };
    expect(verifySpanAnswer(noSolution, derivation)).toMatchObject({ outcome: "correct", coreEvidenceComplete: true, skills: { noSolutionProof: "correct" } });
    expect(verifySpanAnswer(noSolution, { ...derivation, coefficients: ["0", "0"], coordinateChecks: ["0", "0", "0"] })).toMatchObject({ outcome: "incorrect", skills: { noSolutionProof: "incorrect" } });
    expect(verifySpanAnswer(noSolution, { membership: "not_in_span", noSolutionWitness: ["0", "0", "0"] })).toMatchObject({ outcome: "incorrect", skills: { noSolutionProof: "incorrect" } });
  });
  it("checks cross-KC structural claims without claiming to grade free explanations", () => {
    expect(verifySpanAnswer(p, { membership: "in_span", coefficients: ["1/2", "-2/3"], representations: { system: "unique", geometry: "plane" } })).toMatchObject({ outcome: "correct", skills: { systemConsistency: "correct", geometry: "correct" } });
    expect(verifySpanAnswer(p, { membership: "in_span", coefficients: ["1/2", "-2/3"], representations: { system: "infinite", geometry: "line" } })).toMatchObject({ outcome: "incorrect", skills: { systemConsistency: "incorrect", geometry: "incorrect" } });
    const dependent = problem([["1", "2"], ["2", "4"]], ["3", "6"]);
    expect(verifySpanAnswer(dependent, { membership: "in_span", coefficients: ["1", "1"], representations: { system: "infinite", geometry: "line" } }).outcome).toBe("correct");
    const zero = problem([["0", "0"], ["0", "0"]], ["0", "0"]);
    expect(verifySpanAnswer(zero, { membership: "in_span", coefficients: ["0", "0"], representations: { system: "infinite", geometry: "point" } }).skills.geometry).toBe("correct");
    expect(verifySpanAnswer(p, { membership: "in_span", coefficients: ["1/2", "-2/3"], representations: { constraint: "free prose" } }).outcome).toBe("unknown");
  });
  it("does not give process credit when only a final conclusion is provided", () => {
    expect(verifySpanAnswer(p, { membership: "in_span", coefficients: ["1/2", "-2/3"] }).skills).toEqual({ equation: "unobserved", coefficients: "correct", allCoordinates: "unobserved" });
  });
  it("flags an accurate answer supported by a wrong equation or claimed calculation", () => {
    expect(verifySpanAnswer(p, { membership: "in_span", coefficients: ["1/2", "-2/3"], equation: { vectors: p.vectors, target: ["1", "2", "3"] } })).toMatchObject({ outcome: "incorrect", reason: "process_incorrect", skills: { equation: "incorrect", coefficients: "correct" } });
    expect(verifySpanAnswer(p, { membership: "in_span", coefficients: ["1/2", "-2/3"], coordinateChecks: ["1/2", "-2/3", "0"] })).toMatchObject({ outcome: "incorrect", skills: { allCoordinates: "incorrect" } });
  });
  it.each([null, "unstructured prose", { membership: "in_span" }, { membership: "in_span", coefficients: ["1/0", "2"] }, { membership: "in_span", coefficients: ["1", "2"], recognition: "uncertain" }, { membership: "in_span", coefficients: ["1/2", "-2/3"], coordinateChecks: ["1/2"] }])("returns unknown rather than a learner error for uncertain/unparseable input %j", (answer) => {
    expect(verifySpanAnswer(p, answer)).toMatchObject({ outcome: "unknown", countsAsStudentError: false });
  });
  it("can verify confirmed JSON transcriptions and abstains on invalid problem content", () => {
    expect(verifySpanAnswer(p, JSON.stringify({ membership: "in_span", coefficients: ["1/2", "-2/3"] })).outcome).toBe("correct");
    expect(verifySpanAnswer({ ...p, target: ["not a number"] }, { membership: "not_in_span" })).toMatchObject({ outcome: "unknown", countsAsStudentError: false });
  });
  it("retains exactness beyond safe integer precision and rejects hostile sizes", () => {
    const huge = "900719925474099312345678901234567890";
    expect(solveSpanProblem(problem([["1", "0"], ["0", "1"]], [huge, "0.125"]))).toEqual({ kind: "unique", coefficients: [huge, "1/8"] });
    expect(formatSpanRational(parseSpanRational("-0.125")!)).toBe("-1/8");
    expect(parseSpanRational("1".repeat(161))).toBeNull();
    expect(parseSpanRational("1e1000000000")).toBeNull();
  });
});
