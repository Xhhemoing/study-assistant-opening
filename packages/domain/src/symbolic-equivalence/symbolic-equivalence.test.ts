import { describe, expect, it } from "vitest";
import {
  findLinearDependency,
  parseScalarExpr,
  runCSubset408,
  simplifyRadical,
  sturmCount,
  verifyEigenspace,
  verifyIndefiniteIntegral,
  verifyNullspace,
  verifyScalarEquivalence,
  verifySubspaceBasis,
  verifySubspaceEquality,
  verifySubstitutionBounds,
  polynomialAdd,
  polynomialConstant,
  polynomialMultiply,
  polynomialVariable,
} from "./index";
import { rational } from "../opening/span-rational";

describe("bounded symbolic equivalence", () => {
  it("locks natural domains before cancelling denominators", () => {
    expect(verifyScalarEquivalence("x / x", "1").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("x / (2 * x - 1)", "1 / 2").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("x / x", "1", { excluded: [0] }).status).toBe("equivalent");
  });

  it("handles unary minus precedence lower than exponentiation", () => {
    expect(verifyScalarEquivalence("-x^2", "-(x^2)").status).toBe("equivalent");
    expect(verifyScalarEquivalence("-x^2", "x^2").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("(-x)^2", "x^2").status).toBe("equivalent");
    expect(verifyScalarEquivalence("-2^2", "-4").status).toBe("equivalent");
    expect(verifyScalarEquivalence("2^-3", "1 / 8").status).toBe("equivalent");
  });

  it("preserves nested division natural domains", () => {
    expect(verifyScalarEquivalence("1 / (1 / x)", "x").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("1 / (1 / x)", "x", { excluded: [0] }).status).toBe("equivalent");
    expect(verifyScalarEquivalence("1 / (1 + 1 / x)", "x / (x + 1)").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("1 / (1 + 1 / x)", "x / (x + 1)", { excluded: [0] }).status).toBe("equivalent");
  });

  it("uses exact Sturm theorem root counting instead of bounded rational enumeration", () => {
    expect(verifyScalarEquivalence("(x * (x - 100)) / (x - 100)", "x").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("(x * (x - 100)) / (x - 100)", "x", { excluded: [100] }).status).toBe("equivalent");
    expect(verifyScalarEquivalence("(x * (x^2 - 2)) / (x^2 - 2)", "x").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("(x * (x^2 - 2)) / (x^2 - 2)", "x", { intervals: [{ left: 2 }] }).status).toBe("equivalent");
    expect(verifyScalarEquivalence("(x^2 + 1) / (x^2 + 1)", "1").status).toBe("equivalent");

    const x2Minus2 = polynomialAdd(polynomialMultiply(polynomialVariable(), polynomialVariable()), polynomialConstant(rational(2n)), -1);
    expect(sturmCount(x2Minus2, { left: null, right: null, leftOpen: true, rightOpen: true })).toBe(2);
    expect(sturmCount(x2Minus2, { left: rational(0n), right: rational(2n), leftOpen: false, rightOpen: false })).toBe(1);
    expect(sturmCount(x2Minus2, { left: rational(2n), right: null, leftOpen: false, rightOpen: true })).toBe(0);
  });

  it("keeps exact radical branch, quadratic field, and transcendental domain semantics", () => {
    expect(verifyScalarEquivalence("sqrt(x^2)", "abs(x)").status).toBe("equivalent");
    expect(verifyScalarEquivalence("sqrt(x^2)", "x").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("sqrt(x^2)", "x", { intervals: [{ left: 0 }] }).status).toBe("equivalent");
    expect(verifyScalarEquivalence("sqrt(x)^2", "x").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("sqrt(x)^2", "x", { intervals: [{ left: 0 }] }).status).toBe("equivalent");
    expect(verifyScalarEquivalence("sqrt(2 * x)", "sqrt(2) * sqrt(x)", { intervals: [{ left: 0 }] }).status).toBe("equivalent");
    expect(verifyScalarEquivalence("sqrt(x * (x - 1))", "sqrt(x) * sqrt(x - 1)").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("1 / (1 + sqrt(2))", "sqrt(2) - 1").status).toBe("equivalent");
    expect(verifyScalarEquivalence("1 / (sqrt(2) + sqrt(3))", "sqrt(3) - sqrt(2)").status).toBe("equivalent");
    expect(
      simplifyRadical({
        kind: "mul",
        left: { kind: "sqrt", value: { kind: "const", value: 2 } },
        right: { kind: "sqrt", value: { kind: "const", value: 3 } },
      }),
    ).toEqual({ kind: "sqrt", value: { kind: "const", value: 6 } });

    expect(verifyScalarEquivalence("ln(x^2)", "2 * ln(x)").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("ln(x^2)", "2 * ln(x)", { intervals: [{ left: 0, leftOpen: true }] }).status).toBe("equivalent");
    expect(verifyScalarEquivalence("sin(x)^2 + cos(x)^2", "1").status).toBe("equivalent");
    expect(verifyScalarEquivalence("sin(x)", "cos(x)").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("ln(exp(x))", "x").status).toBe("equivalent");
  });

  it("checks derivative residuals, variable forwarding, piecewise integrals, and general substitution bounds", () => {
    expect(verifyIndefiniteIntegral({ student: "x^2 / 2", integrand: "x" }).status).toBe("equivalent");
    expect(verifyIndefiniteIntegral({ student: "t^2 / 2", integrand: "t", variable: "t" }).status).toBe("equivalent");
    expect(verifyIndefiniteIntegral({ student: "ln(abs(x))", integrand: "1 / x" }).status).toBe("equivalent");
    expect(verifyIndefiniteIntegral({ student: "ln(x)", integrand: "1 / x" }).status).toBe("inequivalent");
    expect(
      verifyIndefiniteIntegral({
        student: "ln(abs(x))",
        integrand: "1 / x",
        domain: { excluded: [0] },
        piecewise: {
          split: 0,
          left: parseScalarExpr("ln(-x)")!,
          right: parseScalarExpr("ln(x)")!,
        },
      }).status,
    ).toBe("equivalent");
    expect(
      verifyIndefiniteIntegral({
        student: "x * abs(x) / 2",
        integrand: "abs(x)",
        piecewise: {
          split: 0,
          left: "-x^2 / 2 + 1",
          right: "x^2 / 2",
        },
      }).status,
    ).toBe("inequivalent");

    const sqrtBounds = verifySubstitutionBounds({
      lower: 1,
      upper: 4,
      substitution: "sqrt(x)",
      transformedLower: 1,
      transformedUpper: 2,
    });
    expect(sqrtBounds.status).toBe("equivalent");

    const mismatchBounds = verifySubstitutionBounds({
      lower: 1,
      upper: 2,
      substitution: "x^2",
      transformedLower: 1,
      transformedUpper: 2,
    });
    expect(mismatchBounds.status).toBe("inequivalent");
    expect(mismatchBounds.witness?.detail).toContain("4");
  });
});

describe("exact rational subspaces", () => {
  it("accepts a changed basis, rejects distinct planes with matching rank, and handles mismatched sizes", () => {
    expect(verifySubspaceEquality([[1, 0], [0, 1]], [[1, 1], [1, -1]]).status).toBe("equivalent");
    expect(verifySubspaceEquality([[1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, 1]]).status).toBe("inequivalent");
    expect(verifySubspaceEquality([[1, 0], [0, 1], [1, 1]], [[1, 0], [0, 1]]).status).toBe("equivalent");
    expect(verifySubspaceEquality([], [[0, 0]]).status).toBe("equivalent");
    expect(verifySubspaceBasis([], [[0, 0]]).status).toBe("inequivalent");
    expect(verifySubspaceBasis([[0, 0]], []).status).toBe("equivalent");

    const dependent = findLinearDependency([[1, 0], [0, 1], [1, 1]]);
    expect(dependent?.dependent).toBe(true);
    expect(dependent?.coefficients).toEqual(["-1", "-1", "1"]);
    expect(verifySubspaceBasis([[1, 0], [0, 1]], [[1, 0], [0, 1], [1, 1]]).status).toBe("inequivalent");
  });

  it("checks nullspaces including trivial zero nullspaces and complete independent eigenspaces", () => {
    expect(verifyNullspace([[1, 1]], [[1, -1]]).status).toBe("equivalent");
    expect(verifyNullspace([[1, 0], [0, 1]], []).status).toBe("equivalent");
    expect(verifyNullspace([[1, 0], [0, 1]], [[0, 0]]).status).toBe("equivalent");
    expect(verifyNullspace([[1, 0], [0, 1]], [[1, 0]]).status).toBe("inequivalent");

    expect(verifyEigenspace({ matrix: [[2, 0], [0, 2]], eigenvalue: 2, vectors: [[1, 0], [0, 1]] }).status).toBe("equivalent");
    expect(verifyEigenspace({ matrix: [[2, 0], [0, 2]], eigenvalue: 2, vectors: [[1, 0]] }).status).toBe("inequivalent");
    expect(verifyEigenspace({ matrix: [[2, 0], [0, 2]], eigenvalue: 2, vectors: [[1, 0], [2, 0]] }).status).toBe("inequivalent");
    expect(verifyEigenspace({ matrix: [[2, 0], [0, 2]], eigenvalue: 3, vectors: [] }).status).toBe("inequivalent");
    expect(verifyEigenspace({ matrix: [[2, 1], [0, 2]], eigenvalue: 2, vectors: [[1, 0]] }).status).toBe("equivalent");
  });
});

describe("bounded 408 VM", () => {
  it("reports pointer generation failures and deterministic fuel exhaustion", () => {
    const freed = runCSubset408({
      instructions: [
        { op: "alloc", target: "p", fields: { next: null } },
        { op: "field", target: "next", pointer: { variable: "p" }, field: "next" },
        { op: "free", pointer: { variable: "p" } },
        { op: "load", target: "x", pointer: { variable: "next" } },
      ],
    });
    expect(freed.status).toBe("unverified");
    if (freed.status === "unverified") expect(["use_after_free", "wild_pointer"]).toContain(freed.reason);

    const loop = runCSubset408({ instructions: [{ op: "jump", target: 0 }] }, { fuel: 3 });
    expect(loop.status).toBe("unverified");
    if (loop.status === "unverified") expect(loop.reason).toBe("fuel_exhausted");
  });

  it("preserves null values, structural pointer equality, and rejects non-base frees and bad branch targets", () => {
    const nullPointerRead = runCSubset408({
      instructions: [
        { op: "alloc", target: "p", fields: { next: null } },
        { op: "field", target: "nextPtr", pointer: { variable: "p" }, field: "next" },
        { op: "load", target: "nextVal", pointer: { variable: "nextPtr" } },
        { op: "assign", target: "q", value: { variable: "p" } },
        { op: "binary", target: "samePtr", operator: "==", left: { variable: "p" }, right: { variable: "q" } },
        { op: "binary", target: "isNull", operator: "==", left: { variable: "nextVal" }, right: null },
        { op: "branch", condition: { variable: "samePtr" }, ifTrue: 7, ifFalse: 8 },
        { op: "return", value: { variable: "isNull" } },
        { op: "return", value: false },
      ],
    });
    expect(nullPointerRead.status).toBe("verified");
    if (nullPointerRead.status === "verified") expect(nullPointerRead.value).toBe(true);

    const freeField = runCSubset408({
      instructions: [
        { op: "alloc", target: "p", fields: { next: null } },
        { op: "field", target: "nextPtr", pointer: { variable: "p" }, field: "next" },
        { op: "free", pointer: { variable: "nextPtr" } },
      ],
    });
    expect(freeField.status).toBe("unverified");
    if (freeField.status === "unverified") expect(freeField.reason).toBe("wild_pointer");

    const badBranch = runCSubset408({
      instructions: [{ op: "branch", condition: true, ifTrue: 1.5, ifFalse: 0 }],
    });
    expect(badBranch.status).toBe("unverified");
    if (badBranch.status === "unverified") expect(badBranch.reason).toBe("invalid_jump_target");

    const badCompare = runCSubset408({
      instructions: [
        { op: "const", target: "x", value: null },
        { op: "binary", target: "cmp", operator: "<", left: { variable: "x" }, right: 1 },
      ],
    });
    expect(badCompare.status).toBe("unverified");
    if (badCompare.status === "unverified") expect(badCompare.reason).toBe("type_error");
  });

  it("enforces 8 MiB memory ceiling, alloc length validation, and deterministic 50k step cap", () => {
    const nanAlloc = runCSubset408({
      instructions: [{ op: "alloc", target: "arr", length: Number.NaN }],
    });
    expect(nanAlloc.status).toBe("unverified");
    if (nanAlloc.status === "unverified") expect(nanAlloc.reason).toBe("invalid_instruction");

    const hugeAlloc = runCSubset408({
      instructions: [{ op: "alloc", target: "arr", length: 1_000_000 }],
    });
    expect(hugeAlloc.status).toBe("unverified");
    if (hugeAlloc.status === "unverified") expect(hugeAlloc.reason).toBe("memory_limit_exceeded");

    const loop50k = runCSubset408({
      instructions: [
        { op: "const", target: "i", value: 0 },
        { op: "binary", target: "i", operator: "+", left: { variable: "i" }, right: 1 },
        { op: "binary", target: "cont", operator: "<", left: { variable: "i" }, right: 20_000 },
        { op: "branch", condition: { variable: "cont" }, ifTrue: 1, ifFalse: 4 },
        { op: "return", value: { variable: "i" } },
      ],
      stepLimit: 50_000,
    });
    expect(loop50k.status).toBe("unverified");
    if (loop50k.status === "unverified") expect(loop50k.reason).toBe("fuel_exhausted");
    expect(loop50k.steps).toBe(50_000);
  });
});
