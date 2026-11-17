import { describe, expect, it } from "vitest";
import type { SpanAnswer, SpanProblem } from "@aistudy/contracts";
import { diagnoseSpanRepair, spanRepairCheckMismatches, buildSpanTargetedExplanation, spanRepairPublicContext } from "./span-repair";
import { verifySpanAnswer } from "./span-verifier";

const problem: SpanProblem = { id: "private-span-equations", version: "1", familyId: "span:consistent-3d",
  vectors: [["1", "0", "1"], ["0", "1", "1"]], target: ["1/2", "1/3", "5/6"], knowledgeComponents: ["span"] };
const correct: SpanAnswer = { membership: "in_span", coefficients: ["1/2", "1/3"],
  equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target };
const diagnose = (answer: unknown) => diagnoseSpanRepair(problem, answer, verifySpanAnswer(problem, answer));

describe("#274 earliest verifiable dependency is never the latest displayed failure", () => {
  // Each matrix cell changes the actual observed process, not the title or source text.
  const states = ["correct", "incorrect", "missing"] as const;
  const cells = states.flatMap(equation => states.flatMap(coefficients => states.map(checks => {
    const answer: Record<string, unknown> = { membership: "in_span" };
    if (equation !== "missing") answer.equation = equation === "correct" ? correct.equation : { vectors: problem.vectors, target: ["0", "0", "0"] };
    if (coefficients !== "missing") answer.coefficients = coefficients === "correct" ? correct.coefficients : ["0", "0"];
    // A correct check computes the submitted coefficients, not the problem's target.
    if (checks !== "missing") answer.coordinateChecks = checks === "correct"
      ? coefficients === "incorrect" ? ["0", "0", "0"] : correct.coordinateChecks
      : ["9", "9", "9"];
    const expected = coefficients === "missing" ? { status: "needs_clarification", reasonCode: "evidence_unavailable" }
      : equation === "incorrect" ? { status: "ready", targetSkill: "equation" }
      : coefficients === "incorrect" ? equation === "correct" ? { status: "ready", targetSkill: "coefficients" }
        : { status: "needs_clarification", reasonCode: "predecessor_unobserved" }
      : checks === "incorrect" ? equation === "correct" ? { status: "ready", targetSkill: "allCoordinates" }
        : { status: "needs_clarification", reasonCode: "predecessor_unobserved" }
      : { status: "needs_clarification", reasonCode: "no_verified_error" };
    return { equation, coefficients, checks, answer, expected };
  })));
  it.each(cells)("equation=$equation coefficients=$coefficients checks=$checks", ({ answer, expected }) => {
    expect(diagnose(answer)).toMatchObject(expected);
    expect(diagnose(JSON.stringify(answer))).toEqual(diagnose(answer));
  });

  it.each([
    ["null", null], ["array", []], ["number", 12], ["malformed JSON", "{bad"], ["empty JSON", "{}"],
    ["missing membership", { coefficients: ["1/2", "1/3"] }],
    ["null coefficients", { ...correct, coefficients: null }], ["object coefficients", { ...correct, coefficients: { a: "1/2" } }],
    ["short coefficients", { ...correct, coefficients: ["1/2"] }], ["NaN fraction", { ...correct, coefficients: ["NaN", "1"] }],
    ["zero denominator", { ...correct, coefficients: ["1/0", "1"] }],
    ["incomplete checks", { ...correct, coordinateChecks: ["1/2"] }], ["wrong checks type", { ...correct, coordinateChecks: "5/6" }],
    ["unknown recognition", { ...correct, recognition: "probably" }], ["uncertain recognition", { ...correct, recognition: "uncertain" }],
    ["equation dimension", { ...correct, equation: { vectors: [["1"], ["0"]], target: ["1"] } }],
  ])("unparseable/unconfirmed %s never accuses a learner", (_name, answer) => {
    expect(diagnose(answer)).toEqual({ status: "needs_clarification", reasonCode: "evidence_unavailable" });
    expect(verifySpanAnswer(problem, answer).countsAsStudentError).toBe(false);
  });

  it.each(["equation", "coefficients", "allCoordinates", "geometry", "systemConsistency", "noSolutionProof"] as const)("rejects persisted revision whose recorded %s no longer matches recomputation", key => {
      const answer = { ...correct, coordinateChecks: ["1/2", "1/3", "0"] };
      const recorded = verifySpanAnswer(problem, answer);
      expect(diagnoseSpanRepair(problem, answer, { ...recorded, skills: { ...recorded.skills, [key]: recorded.skills[key] === "incorrect" ? "correct" : "incorrect" } }))
        .toEqual({ status: "needs_clarification", reasonCode: "verification_mismatch" });
    });
  it("rejects an outcome-only revision mismatch even when the skill map agrees", () => {
    const answer = { ...correct, coefficients: ["0", "0"] };
    const recorded = verifySpanAnswer(problem, answer);
    expect(diagnoseSpanRepair(problem, answer, { ...recorded, outcome: "correct" }))
      .toEqual({ status: "needs_clarification", reasonCode: "verification_mismatch" });
  });
  it.each(["line", "point"] as const)("wrong geometry %s conflicts with a linear earliest-step selection", geometry => {
    expect(diagnose({ ...correct, coefficients: ["0", "0"], representations: { geometry } }))
      .toEqual({ status: "needs_clarification", reasonCode: "ambiguous_branch" });
  });
  it.each(["none", "infinite"] as const)("wrong system classification %s cannot be silently ignored", system => {
    expect(diagnose({ ...correct, representations: { system } }))
      .toEqual({ status: "needs_clarification", reasonCode: "unsupported_target" });
  });
});

describe("arithmetic mismatch coordinates are different from target mismatch coordinates", () => {
  it.each([
    { check: ["0", "0", "0"], expected: [] }, { check: ["1", "0", "0"], expected: [0] },
    { check: ["0", "1", "0"], expected: [1] }, { check: ["0", "0", "1"], expected: [2] },
    { check: ["1", "1", "1"], expected: [0, 1, 2] },
  ])("wrong submitted coefficients with check=$check", ({ check, expected }) => {
    const answer = { ...correct, coefficients: ["0", "0"], coordinateChecks: check };
    expect(verifySpanAnswer(problem, answer).failedCoordinates).toEqual([0, 1, 2]);
    expect(spanRepairCheckMismatches(problem, answer)).toEqual(expected);
    expect(diagnose(answer)).toEqual({ status: "ready", targetSkill: "coefficients", checkMismatchCoordinates: expected });
  });
  it("equivalent rational strings do not become arithmetic errors", () => {
    expect(spanRepairCheckMismatches(problem, { ...correct, coefficients: ["2/4", "2/6"], coordinateChecks: ["3/6", "3/9", "10/12"] })).toEqual([]);
  });
});

describe("targeted explanation and public focus do not transplant a solution into context", () => {
  it.each(["equation", "coefficients", "allCoordinates"] as const)("one dependency %s determines executable math", targetSkill => {
    const result = buildSpanTargetedExplanation(problem, targetSkill)!;
    expect(result.targetSkill).toBe(targetSkill);
    expect(result.workedSteps.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).toContain("5/6");
    const plan = { status: "ready", version: 2, contentVersion: 5, targetSkill,
      teachingExample: { reservedAnswer: "PRIVATE_EXAMPLE" }, practiceVariant: { answer: "PRIVATE_VARIANT" },
      confirmation: { answer: "PRIVATE_CONFIRMATION" } } as unknown as Parameters<typeof spanRepairPublicContext>[0];
    const publicContext = spanRepairPublicContext(plan);
    expect(publicContext).toMatchObject({ status: "ready", version: 2, contentVersion: 5, targetSkill, prerequisiteStatus: "unknown" });
    expect(JSON.stringify(publicContext)).not.toContain("PRIVATE_");
    expect(Object.keys(publicContext).sort()).toEqual(["contentVersion", "focusSummary", "prerequisiteStatus", "status", "targetSkill", "version"]);
  });
  it("clarification does not retain stale target or private answer references", () => {
    const plan = { status: "needs_clarification", version: 4, reasonCode: "verification_mismatch", targetSkill: "equation", answer: "PRIVATE_SENTINEL" } as unknown as Parameters<typeof spanRepairPublicContext>[0];
    const context = spanRepairPublicContext(plan);
    expect(context).toMatchObject({ status: "needs_clarification", version: 4, reasonCode: "verification_mismatch", prerequisiteStatus: "unknown" });
    expect(context).not.toHaveProperty("targetSkill"); expect(JSON.stringify(context)).not.toContain("PRIVATE_SENTINEL");
  });
});
