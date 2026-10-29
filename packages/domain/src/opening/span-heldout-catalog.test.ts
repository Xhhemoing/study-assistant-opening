import { describe, expect, it } from "vitest";
import type { SpanSolution } from "@aistudy/contracts";
import { getSpanReservedProblem, listSpanReservedProblems, spanValidationEligibility } from "./span-heldout-catalog";
import { solveSpanProblem, verifySpanAnswer } from "./span-verifier";

const expectations: { suffix: string; solution: SpanSolution; witness?: string[] }[] = [
  { suffix: "q01", solution: { kind: "unique", coefficients: ["2", "-3"] } },
  { suffix: "q02", solution: { kind: "unique", coefficients: ["-3", "1"] } },
  { suffix: "q03", solution: { kind: "none" }, witness: ["-2", "1", "1"] },
  { suffix: "q04", solution: { kind: "infinite", particular: ["5/2", "0"], directions: [["2", "1"]] } },
  { suffix: "q05", solution: { kind: "unique", coefficients: ["-1/3", "3/4"] } },
  { suffix: "q06", solution: { kind: "unique", coefficients: ["-2", "3"] } },
  { suffix: "q07", solution: { kind: "none" }, witness: ["1", "0", "1"] },
  { suffix: "q08", solution: { kind: "infinite", particular: ["0", "-1/2"], directions: [["1", "0"]] } },
];

describe("new reserved span candidates", () => {
  it("includes expanded families in both executable pools without relaxing first-family eligibility", () => {
    for (const purpose of ["validation", "retest"] as const) {
      const pool = listSpanReservedProblems(purpose);
      const generated = pool.filter(p => p.id.startsWith("span-reserved-generated-"));
      expect(generated).toHaveLength(84);
      for (const p of generated) {
        expect(getSpanReservedProblem(p.id, p.version)).toEqual(p);
        expect(spanValidationEligibility(p, [{ itemId: "earlier", itemVersion: "1", familyId: p.familyId, use: "demonstration", releasedAt: "2026-01-01T00:00:00Z" }], true)).toEqual({ eligible: true, reasons: [], unseenFamily: false });
      }
    }
  });
  it.each(expectations)("matches independently calculated coefficients or contradiction witness for $suffix", ({ suffix, solution, witness }) => {
    const problem = getSpanReservedProblem(`span-reserved-20261021-${suffix}`)!;
    expect(problem).not.toBeNull();
    expect(solveSpanProblem(problem)).toEqual(solution);
    const equation = { vectors: problem.vectors, target: problem.target };
    const answer = solution.kind === "none"
      ? { membership: "not_in_span", equation, noSolutionWitness: witness }
      : { membership: "in_span", equation, coefficients: solution.kind === "unique" ? solution.coefficients : solution.kind === "infinite" ? solution.particular : [], coordinateChecks: problem.target };
    expect(verifySpanAnswer(problem, answer)).toMatchObject({ outcome: "correct", coreEvidenceComplete: true });
    expect(problem).not.toHaveProperty("transfer");
  });

  it("preserves legacy mathematical identities and does not reuse unavailable historical IDs", () => {
    expect(solveSpanProblem(getSpanReservedProblem("span-reserved-fraction")!)).toEqual({ kind: "unique", coefficients: ["1/2", "-2/3"] });
    expect(solveSpanProblem(getSpanReservedProblem("span-reserved-dependent")!)).toEqual({ kind: "infinite", particular: ["-2", "0"], directions: [["-3", "1"]] });
    expect(solveSpanProblem(getSpanReservedProblem("span-reserved-transfer")!)).toEqual({ kind: "none" });
    for (const { suffix } of expectations) {
      expect(getSpanReservedProblem(`span-reserved-parallel-${suffix}`)).toBeNull();
      expect(getSpanReservedProblem(`span-reserved-20261021-${suffix}`, "2")).toBeNull();
    }
  });

  it("keeps family exposure and uncertain history distinct from a new item ID", () => {
    const problem = getSpanReservedProblem("span-reserved-20261021-q04")!;
    const exposure = { itemId: "span-contrast-dependent", itemVersion: "1", familyId: "span:dependent-generators", use: "demonstration" as const, releasedAt: "2026-10-20T12:00:00Z" };
    expect(spanValidationEligibility(problem, [exposure], true)).toEqual({ eligible: true, reasons: [], unseenFamily: false });
    expect(spanValidationEligibility(problem, [], false)).toEqual({ eligible: false, reasons: ["exposure_history_unknown"], unseenFamily: false });
    expect(spanValidationEligibility(problem, [{ ...exposure, itemId: problem.id }], true)).toMatchObject({ eligible: false, reasons: ["previous_demonstration"] });
  });

  it("returns detached copies so one caller cannot rewrite another attempt's catalog", () => {
    const first = listSpanReservedProblems();
    const item = first.find(problem => problem.id === "span-reserved-20261021-q01")!;
    item.vectors[0][0] = "100";
    item.target[0] = "100";
    expect(getSpanReservedProblem(item.id)).toMatchObject({ vectors: [["2", "1"], ["1", "-1"]], target: ["1", "5"] });
  });
});
