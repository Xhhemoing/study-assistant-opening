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
    const items = listGeneratedSpanItems(purpose).filter(problem => problem.familyId === "span:rational-3d"); expect(items).toHaveLength(12);
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
it("supplies every existing family with twelve exact, disjoint and reproducible items per purpose", () => {
  const families = ["span:rational-3d", "span:independent-2d", "span:consistent-3d", "span:inconsistent-3d", "span:dependent-generators", "span:geometry-line", "span:geometry-plane"];
  const keys = new Set<string>();
  for (const purpose of ["teaching", "validation", "retest", "research"] as const) {
    const items = listGeneratedSpanItems(purpose);
    for (const family of families) expect(items.filter(p => p.familyId === family)).toHaveLength(12);
    for (const p of items) {
      expect(parseGeneratedSpanItem(p.id, p.version)).toEqual({ problem: p, purpose });
      expect(keys.has(spanProblemContentKey(p))).toBe(false); keys.add(spanProblemContentKey(p));
      expect(p.transfer).toBeUndefined();
      const solution = solveSpanProblem(p);
      if (p.familyId === "span:inconsistent-3d") expect(solution.kind).toBe("none");
      else if (p.familyId === "span:dependent-generators") expect(solution.kind).toBe("infinite");
      else if (p.familyId === "span:geometry-line") expect(["none", "infinite"]).toContain(solution.kind);
      else if (p.familyId === "span:geometry-plane") expect(["none", "unique"]).toContain(solution.kind);
      else expect(solution.kind).toBe("unique");
      if (solution.kind === "unique" || solution.kind === "infinite") {
        expect(verifySpanAnswer(p, { membership: "in_span", equation: p, coordinateChecks: p.target,
          coefficients: solution.kind === "unique" ? solution.coefficients : solution.particular })).toMatchObject({ outcome: "correct", coreEvidenceComplete: true });
      }
      if (solution.kind === "none") {
        const witness = p.familyId === "span:geometry-line" ? [String(-Number(p.vectors[0]![1])), "1", "0"]
          : [String(Number(p.vectors[0]![1]) * Number(p.vectors[1]![2]) - Number(p.vectors[0]![2])), String(-Number(p.vectors[1]![2])), "1"];
        expect(verifySpanAnswer(p, { membership: "not_in_span", equation: p, noSolutionWitness: witness })).toMatchObject({ outcome: "correct", coreEvidenceComplete: true });
      }
      expect(getSpanProblem(p.id)).toBeNull();
      expect(getSpanReservedProblem(p.id) !== null).toBe(purpose === "validation" || purpose === "retest");
    }
  }
});
it("preserves C1 operands for old seed identities and rejects unsupported expanded identities", () => {
  for (const seed of [0, 1729, 9999]) for (const purpose of ["teaching", "validation", "retest", "research"] as const) {
    for (let index = 0; index < 12; index++) {
      const n = BigInt(seed * 64 + ["teaching", "validation", "retest", "research"].indexOf(purpose) * 12 + index + 2);
      expect(parseGeneratedSpanItem(`span-reserved-generated-${purpose}-${seed}-${index}`, "1")?.problem).toMatchObject({
        familyId: "span:rational-3d", vectors: [[String(n), "0", "1"], ["0", String(n + 1n), "-1"]],
        target: [formatSpanRational(rational(n * n, 2n)), formatSpanRational(rational(-(n + 1n) * (n + 1n), 3n)), formatSpanRational(rational(5n * n + 2n, 6n))],
      });
    }
  }
  const id = "span-reserved-generated-validation-independent-2d-1729-0";
  for (const invalid of [id.replace("independent-2d", "unknown"), id.replace("1729-0", "01729-0"), id.replace("1729-0", "1729-12")]) expect(parseGeneratedSpanItem(invalid, "1")).toBeNull();
  expect(parseGeneratedSpanItem(id, "2")).toBeNull();
});
it("varies new-family coefficients with purpose and seed, with independently calculated exact solutions", () => {
  for (const family of ["independent-2d", "consistent-3d", "dependent-generators", "geometry-line", "geometry-plane"]) {
    const answers = new Set<string>();
    for (const [partition, purpose] of (["teaching", "validation", "retest", "research"] as const).entries()) {
      const p = generateSpanItem(purpose, 0, 1729, "1", family);
      const expected = family === "dependent-generators" || family === "geometry-line"
        ? { kind: "infinite", particular: [String(partition - 5), "0"], directions: [["-2", "1"]] }
        : { kind: "unique", coefficients: [String(partition - 5), String(partition)] };
      expect(solveSpanProblem(p)).toEqual(expected); answers.add(JSON.stringify(expected));
      const alternate = generateSpanItem(purpose, 0, 1730, "1", family);
      expect(spanProblemContentKey(alternate)).not.toBe(spanProblemContentKey(p));
      expect(parseGeneratedSpanItem(alternate.id, alternate.version)?.problem).toEqual(alternate);
    }
    expect(answers.size).toBe(4);
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
