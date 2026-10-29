import { expect, it } from "vitest";
import { generateSpanItem, listGeneratedSpanItems, parseGeneratedSpanItem, spanProblemContentKey } from "./span-generated-items";
import { getSpanReservedProblem, spanValidationEligibility } from "./span-heldout-catalog";
import { getSpanProblem } from "./span-teaching-catalog";
import { solveSpanProblem, verifySpanAnswer } from "./span-verifier";
import { formatSpanRational, rational } from "./span-rational";
it("reproduces seed/version/ordinal and cross-checks all four disjoint partitions with the exact solver", () => {
  const keys = new Set<string>();
  const answers = new Set<string>();
  for (const purpose of ["teaching", "validation", "retest", "research"] as const) {
    const items = listGeneratedSpanItems(purpose); expect(items).toHaveLength(12);
    for (const [index, problem] of items.entries()) {
      expect(generateSpanItem(purpose, index)).toEqual(problem);
      expect(parseGeneratedSpanItem(problem.id, problem.version)).toEqual({ problem, purpose });
      const key = spanProblemContentKey(problem); expect(keys.has(key)).toBe(false); keys.add(key);
      const n = BigInt(problem.vectors[0][0]!);
      const coefficients = [formatSpanRational(rational(n, 2n)), formatSpanRational(rational(-(n + 1n), 3n))];
      expect(answers.has(JSON.stringify(coefficients))).toBe(false); answers.add(JSON.stringify(coefficients));
      expect(solveSpanProblem(problem)).toEqual({ kind: "unique", coefficients });
      expect(verifySpanAnswer(problem, { membership: "in_span", coefficients, equation: problem,
        coordinateChecks: problem.target })).toMatchObject({ outcome: "correct", coreEvidenceComplete: true });
      expect(problem.transfer).toBeUndefined();
      expect(getSpanProblem(problem.id)).toBeNull();
      expect(getSpanReservedProblem(problem.id) !== null).toBe(purpose === "validation" || purpose === "retest");
    }
  }
});
it("normalizes rational content independently of name, purpose and version", () => {
  const problem = generateSpanItem("validation", 0);
  const renamed = { ...problem, id: "renamed", version: "2", target: problem.target.map(value => { const [n, d = "1"] = value.split("/"); return `${BigInt(n!) * 2n}/${BigInt(d) * 2n}`; }) };
  expect(spanProblemContentKey(renamed)).toBe(spanProblemContentKey(problem));
  expect(spanValidationEligibility(renamed, [{ itemId: problem.id, itemVersion: problem.version, familyId: problem.familyId,
    use: "independent_answer", releasedAt: "2026-01-01T00:00:00Z" }], true)).toMatchObject({ eligible: false, unseenFamily: false });
  expect(parseGeneratedSpanItem(problem.id, "2")).toBeNull();
  expect(() => generateSpanItem("validation", 12)).toThrow();
});
