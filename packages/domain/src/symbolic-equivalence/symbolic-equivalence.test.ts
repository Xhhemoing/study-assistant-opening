import { describe, expect, it } from "vitest";
import { simplifyRadical, verifyIndefiniteIntegral, verifyScalarEquivalence, verifySubstitutionBounds } from "./calculus";
import { findLinearDependency, verifyEigenspace, verifyNullspace, verifySubspaceBasis, verifySubspaceEquality } from "./subspace";
import { runCSubset408 } from "./c-subset-408";

describe("bounded symbolic equivalence", () => {
  it("locks natural domains before cancelling denominators", () => {
    expect(verifyScalarEquivalence("x / x", "1").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("x / (2 * x - 1)", "1 / 2").status).toBe("inequivalent");
    const result = verifyScalarEquivalence("x / x", "1", { excluded: [0] });
    expect(result.status).toBe("equivalent");
  });
  it("keeps exact radical branch semantics", () => {
    expect(verifyScalarEquivalence("sqrt(x^2)", "abs(x)").status).toBe("equivalent");
    expect(verifyScalarEquivalence("sqrt(x^2)", "x").status).toBe("inequivalent");
    expect(simplifyRadical({ kind: "mul", left: { kind: "sqrt", value: { kind: "const", value: 2 } }, right: { kind: "sqrt", value: { kind: "const", value: 3 } } })).toEqual({ kind: "sqrt", value: { kind: "const", value: 6 } });
  });
  it("checks derivative residuals and transformed bounds exactly", () => {
    expect(verifyIndefiniteIntegral({ student: "x^2 / 2", integrand: "x" }).status).toBe("equivalent");
    const bounds = verifySubstitutionBounds({ lower: 1, upper: 2, substitution: "x^2", transformedLower: 1, transformedUpper: 2 });
    expect(bounds.status).toBe("inequivalent");
    expect(bounds.witness?.detail).toContain("4");
  });
});

describe("exact rational subspaces", () => {
  it("accepts a changed basis and returns dependency witnesses", () => {
    expect(verifySubspaceEquality([[1, 0], [0, 1]], [[1, 1], [1, -1]]).status).toBe("equivalent");
    const dependent = findLinearDependency([[1, 0], [0, 1], [1, 1]]);
    expect(dependent?.dependent).toBe(true);
    expect(dependent?.coefficients).toEqual(["-1", "-1", "1"]);
    expect(verifySubspaceBasis([[1, 0], [0, 1]], [[1, 0], [0, 1], [1, 1]]).status).toBe("inequivalent");
  });
  it("checks nullspaces and repeated eigenspaces", () => {
    expect(verifyNullspace([[1, 1]], [[1, -1]]).status).toBe("equivalent");
    expect(verifyEigenspace({ matrix: [[2, 0], [0, 2]], eigenvalue: 2, vectors: [[1, 0], [0, 1]] }).status).toBe("equivalent");
  });
});

describe("bounded 408 VM", () => {
  it("reports pointer generation failures and fuel exhaustion", () => {
    const freed = runCSubset408({ instructions: [
      { op: "alloc", target: "p", fields: { next: null } },
      { op: "field", target: "next", pointer: { variable: "p" }, field: "next" },
      { op: "free", pointer: { variable: "p" } },
      { op: "load", target: "x", pointer: { variable: "next" } },
    ] });
    expect(freed.status).toBe("unverified");
    if (freed.status === "unverified") expect(["use_after_free", "wild_pointer"]).toContain(freed.reason);
    const loop = runCSubset408({ instructions: [{ op: "jump", target: 0 }] }, { fuel: 3 });
    expect(loop.status).toBe("unverified");
    if (loop.status === "unverified") expect(loop.reason).toBe("fuel_exhausted");
  });
});
