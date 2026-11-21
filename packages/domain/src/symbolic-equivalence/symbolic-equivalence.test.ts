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
    expect(verifyScalarEquivalence("ln(x^2)", "2 * ln(abs(x))").status).toBe("equivalent");
    expect(verifyScalarEquivalence("sin(x)^2 + cos(x)^2", "1").status).toBe("equivalent");
    expect(verifyScalarEquivalence("sin(x)", "cos(x)").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("ln(exp(x))", "x").status).toBe("equivalent");
  });

  it("closes Round-3 soundness guards for abs cell-splitting, non-rational domains, isolated irrational roots, sqrt scaling, and fail-closed limits", () => {
    // P1-1: abs(...) CAD cell splitting & Sturm interior sign check
    expect(verifyScalarEquivalence("abs(x - 4)", "4 - x").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("abs(x^2 - 100)", "100 - x^2").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("abs(x - 3/4)", "3/4 - x", { intervals: [{ left: 0, right: 1, rightOpen: true }] }).status).toBe("inequivalent");
    expect(verifyScalarEquivalence("abs((4 * x - 3) * (x^2 + 1))", "(3 - 4 * x) * (x^2 + 1)", { intervals: [{ left: 0, right: 1, rightOpen: true }] }).status).toBe("inequivalent");
    expect(verifyScalarEquivalence("abs(x^2 - 2)", "2 - x^2", { intervals: [{ left: 1, right: "3/2" }] }).status).toBe("inequivalent");
    expect(verifyScalarEquivalence("abs(x - 4)", "4 - x", { intervals: [{ left: 0, right: 4 }] }).status).toBe("equivalent");

    // P1-2: non-rational domain holes & quadratic binomial denominators
    expect(verifyScalarEquivalence("sin(x) / sin(x)", "1").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("(exp(x) - 2) / (exp(x) - 2)", "1").status).toBe("unverified");
    expect(verifyScalarEquivalence("1 / x", "1 / sin(x)", { intervals: [{ left: 0, right: 0 }] }).status).toBe("unverified");
    expect(verifyScalarEquivalence("(sqrt(x) - 2) / (sqrt(x) - 2)", "1", { intervals: [{ left: 0 }] }).status).toBe("inequivalent");
    expect(verifyScalarEquivalence("(x - 100) / (sqrt(x) - 10)", "sqrt(x) + 10", { intervals: [{ left: 0 }] }).status).toBe("inequivalent");
    expect(verifyScalarEquivalence("(x - 100) / (sqrt(x) - 10)", "sqrt(x) + 10", { intervals: [{ left: 0 }], excluded: [100] }).status).toBe("equivalent");
    expect(verifyScalarEquivalence("(sqrt(x) + 2) / (sqrt(x) + 2)", "1", { intervals: [{ left: 0 }] }).status).toBe("equivalent");
    expect(verifyScalarEquivalence("exp(ln(abs(x - 10)))", "abs(x - 10)").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("exp(ln(abs(x - 10)))", "abs(x - 10)", { excluded: [10] }).status).toBe("equivalent");

    // P1-3: signAtSampleSite on isolated irrational roots adjacent to rational roots
    expect(
      verifyScalarEquivalence("sqrt(2*x^2 - 1) * ((x - 1)*(2*x^2 - 1)) / ((x - 1)*(2*x^2 - 1))", "sqrt(2*x^2 - 1)", {
        intervals: [{ left: 0, right: 2 }],
        excluded: [1],
      }).status,
    ).toBe("inequivalent");
    expect(
      verifyScalarEquivalence("sqrt(x^2 - 2) * (x - 1) / (x - 1)", "sqrt(x^2 - 2)", {
        intervals: [{ left: 0, right: 2 }],
        excluded: [1],
      }).status,
    ).toBe("equivalent");

    // P1-4: sqrt(inner / dVal) denominator |dVal| scaling
    expect(verifyScalarEquivalence("sqrt((sin(x) + 2) / 4)", "sqrt(sin(x) + 2) / 2").status).toBe("equivalent");
    expect(verifyScalarEquivalence("sqrt((exp(x) + 1) / 2)", "sqrt(2 * exp(x) + 2) / 2").status).toBe("equivalent");
    expect(verifyScalarEquivalence("sqrt((exp(x) + 1) / 2)", "sqrt(2 * exp(x) + 2) / sqrt(2)").status).toBe("inequivalent");

    // P2-2: mpolyMultiply overflow fails closed instead of silently truncating
    const largeSum = "sin(x) + sin(2*x) + sin(3*x) + sin(4*x) + sin(5*x) + sin(6*x) + sin(7*x) + sin(8*x) + sin(9*x) + sin(10*x)";
    expect(verifyScalarEquivalence(`(${largeSum})^4`, `(${largeSum})^4`).status).toBe("unverified");

    // P2-3: rational probe count accounts for excluded points & combinedDen degree, and singleton checks stay valid
    expect(
      verifyScalarEquivalence("x - 1/2", "0", {
        intervals: [{ left: 0, right: 1, leftOpen: true, rightOpen: true }],
        excluded: ["3/4", "7/8", "15/16", "31/32", "63/64", "127/128"],
      }).status,
    ).toBe("inequivalent");
    expect(
      verifyIndefiniteIntegral({
        student: "x * abs(x) / 2",
        integrand: "abs(x)",
        piecewise: {
          split: 0,
          left: "-x^2 / 2",
          right: "x^2 / 2",
        },
      }).status,
    ).toBe("equivalent");
  });

  it("closes Round-4 non-rational domain mismatches, symmetric exact undefinedness, float cancellation, and empty-domain guards", () => {
    // P1-1: unresolved CAD domain mismatches fail closed (or prove defined at isolated/rational sites)
    expect(
      verifyScalarEquivalence("((x^2 - 2) / (x^2 - 2)) * (1 / (exp(x) - 2))", "1 / (exp(x) - 2)").status,
    ).toBe("inequivalent");
    expect(
      verifyScalarEquivalence("((x - 1) / (x - 1)) * (1 / (exp(x) - 2) + abs(x - 1))", "1 / (exp(x) - 2) + abs(x - 1)").status,
    ).toBe("inequivalent");
    expect(
      verifyScalarEquivalence("((x - 100) / (x - 100)) * (1 / (exp(x) - 2))", "1 / (exp(x) - 2)").status,
    ).toBe("unverified");
    expect(
      verifyIndefiniteIntegral({
        student: "ln(x - 100) + ln(abs(exp(x) - 2))",
        integrand: "1 / (x - 100) + exp(x) / (exp(x) - 2)",
        domain: { intervals: [{ left: 60, right: 90 }] },
      }).status,
    ).not.toBe("equivalent");
    expect(
      verifyIndefiniteIntegral({
        student: "ln(x - 100) + ln(abs(exp(x - 60) - 2))",
        integrand: "1 / (x - 100) + exp(x - 60) / (exp(x - 60) - 2)",
        domain: { intervals: [{ left: 60, right: 90 }] },
      }).status,
    ).toBe("inequivalent");
    expect(
      verifyIndefiniteIntegral({
        student: "ln(x - 100) + ln(abs(exp(x) - 2))",
        integrand: "1 / (x - 100) + exp(x) / (exp(x) - 2)",
        domain: { intervals: [{ left: 0, right: 90 }] },
      }).status,
    ).toBe("inequivalent");

    // P1-2: symmetric undefined_domain vs unsupported in evaluateExactRationalExt
    expect(
      verifyScalarEquivalence("ln(sqrt(x)) + sqrt(x + 2)", "sqrt(x + 2) + ln(sqrt(x))", {
        intervals: [{ left: 0, right: 1 }],
      }).status,
    ).toBe("equivalent");
    expect(
      verifyScalarEquivalence("ln(sqrt(x)) + 1 / sin(x)", "1 / sin(x) + ln(sqrt(x))", {
        intervals: [{ left: 0, right: 1 }],
      }).status,
    ).toBe("equivalent");

    // P1-3: IEEE-754 cancellation never fabricates undefined_domain; exact sin(0)=0 still proves sin(x)/sin(x) != 1
    expect(
      verifyScalarEquivalence("sin(x) / (100000000000000000 * ((1 + 1/100000000000000000) - 1))", "sin(x)").status,
    ).toBe("equivalent");
    expect(
      verifyScalarEquivalence("ln((1 + 1/100000000000000000) - 1) + sin(x)", "ln(1/100000000000000000) + sin(x)").status,
    ).toBe("equivalent");
    expect(verifyScalarEquivalence("sin(x) / sin(x)", "1").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("sin(0) / sin(0)", "1").status).toBe("inequivalent");
    expect(
      verifyScalarEquivalence("sin(x) * (100000000000000000 * ((1 + 1/100000000000000000) - 1) + 1)", "2 * sin(x)").status,
    ).toBe("equivalent");

    // P2-1: empty natural domain on identical uncheckedOps fails closed
    expect(verifyScalarEquivalence("1 / sin(x)", "1 / sin(x)", { intervals: [{ left: 0, right: 0 }] }).status).toBe("unverified");
    expect(verifyScalarEquivalence("sqrt(sin(x) - 2)", "sqrt(sin(x) - 2)").status).toBe("unverified");
  });

  it("closes Round-5 open-cell non-rational mismatches, rational-to-float radius gaps, and piecewise integrand domain checks", () => {
    // P1-1: open-cell non-rational domain mismatches must not be dismissed by finite undefined_domain probes
    expect(
      verifyScalarEquivalence("(sqrt(x) / sqrt(x)) * sqrt(sin(x) - 1/2)", "sqrt(sin(x) - 1/2)").status,
    ).toBe("inequivalent");
    expect(
      verifyScalarEquivalence("(sqrt(x) / sqrt(x)) * sqrt(exp(x^2) - 10000)", "sqrt(exp(x^2) - 10000)").status,
    ).toBe("inequivalent");
    expect(
      verifyIndefiniteIntegral({
        student: "ln(x) + 2 * sqrt(sin(x) - 1/2)",
        integrand: "1 / x + cos(x) / sqrt(sin(x) - 1/2)",
      }).status,
    ).toBe("inequivalent");

    // P1-2: rationalToFloatArg preserves rounding radius so 99999999999999999/100000000000000000 does not round to exact 1
    expect(
      verifyScalarEquivalence(
        "((100000000000000000 * x - 99999999999999999) / (100000000000000000 * x - 99999999999999999)) * sqrt(exp(x - 1) - 1)",
        "sqrt(exp(x - 1) - 1)",
      ).status,
    ).not.toBe("inequivalent");
    expect(
      verifyScalarEquivalence("sqrt(ln(x))", "sqrt(ln(x))", {
        intervals: [{ left: "99999999999999999/100000000000000000", right: "99999999999999999/100000000000000000" }],
      }).status,
    ).toBe("unverified");

    // P2: piecewise antiderivative integrand domain coverage check
    expect(
      verifyIndefiniteIntegral({
        student: "ln(x - 10)",
        integrand: "1 / (x - 10)",
        piecewise: { split: 20, left: "ln(x - 10)", right: "ln(x - 10)" },
      }).status,
    ).toBe("inequivalent");
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
