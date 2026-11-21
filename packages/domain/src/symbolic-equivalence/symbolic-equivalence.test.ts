import { describe, expect, it } from "vitest";
import {
  differentiate,
  evaluateScalar,
  findLinearDependency,
  normalizeLatexExpr,
  parseScalarExpr,
  rationalForm,
  rref,
  runCSubset408,
  simplifyRadical,
  sturmCount,
  type ScalarExpr,
  verifyEigenspace,
  verifyIndefiniteIntegral,
  verifyMatrixExpressionEquivalence,
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

    // Round-6 P1-4: student antiderivative non-rational domain ops on open cells fail closed
    expect(
      verifyIndefiniteIntegral({
        student: "x + ln(sin(x))^0",
        integrand: "1",
      }).status,
    ).not.toBe("equivalent");
    expect(
      verifyIndefiniteIntegral({
        student: "x + ln(sin(x))^0",
        integrand: "1",
        domain: { intervals: [{ left: "0.1", right: "3" }] },
      }).status,
    ).toBe("unverified");
    expect(
      verifyIndefiniteIntegral({
        student: "x + ln(exp(x) - 2)^0",
        integrand: "1",
      }).status,
    ).toBe("inequivalent");
    expect(
      verifyIndefiniteIntegral({
        student: "x + ln(exp(x) - 3/2)^0",
        integrand: "1",
        domain: { intervals: [{ left: "0.5", right: 2 }] },
      }).status,
    ).toBe("unverified");

    // Round-10 P1-1: > 2^4096 constant in buildCadPlan / verifyIndefiniteIntegral fails closed without uncaught PolyComplexityError
    const hugeConst = (1n << 4097n).toString();
    const hugeIntegral = verifyIndefiniteIntegral({
      student: `x + (ln(x + ${hugeConst}))^0`,
      integrand: "1",
    });
    expect(hugeIntegral.status).toBe("unverified");
    expect(hugeIntegral.reason).toBe("polynomial_complexity_exceeded");

    const hugeScalar = verifyScalarEquivalence(`sqrt(x + ${hugeConst})`, `sqrt(x + ${hugeConst})`);
    expect(hugeScalar.status).toBe("unverified");
    expect(hugeScalar.reason).toBe("polynomial_complexity_exceeded");

    // Round-6 P1-5: unresolved multi-root Sturm bracket at depth cap fails closed
    const m = "38685626227668133590597632";
    const closeRootsResult = verifyScalarEquivalence(
      `abs((${m} * x - 1) * (${m} * x - 2))`,
      `(${m} * x - 1) * (${m} * x - 2)`,
    );
    expect(closeRootsResult.status).toBe("unverified");
    expect(closeRootsResult.reason).toBe("unresolved_root_isolation");

    // Round-7 P1-A: unbracketed root after 64 Sturm steps fails closed and closed endpoints outside [-3, 3] are probed
    const unresolvedBigCoeff = verifyScalarEquivalence(
      "sqrt(2722258935367507707706996859454145691648 * x^2 - 1)^2",
      "2722258935367507707706996859454145691648 * x^2 - 1",
      { intervals: [{ left: 0, right: 2, leftOpen: true }] },
    );
    expect(unresolvedBigCoeff.status).toBe("unverified");
    expect(unresolvedBigCoeff.reason).toBe("unresolved_root_isolation");
    expect(
      verifyScalarEquivalence("abs(x^2 - 110) + sin(x - 12) / sin(x - 12)", "abs(x^2 - 110) + 1", {
        intervals: [{ left: 10, right: 12 }],
      }).status,
    ).toBe("inequivalent");
    expect(
      verifyScalarEquivalence("abs(x^2 - 110) + sin(x - 10) / sin(x - 10)", "abs(x^2 - 110) + 1", {
        intervals: [{ left: 10, right: 12 }],
      }).status,
    ).toBe("inequivalent");

    // Round-8 P1-3: nested symbolic polynomial powers & dense degree-64 cross-multiplies fail closed cleanly
    const nestedPow = verifyScalarEquivalence("((((x + 1)^12)^12)^12)^12", "((((x + 1)^12)^12)^12)^12");
    expect(nestedPow.status).toBe("unverified");
    expect(nestedPow.reason).toBe("polynomial_complexity_exceeded");

    const poly8A = Array.from({ length: 9 }, (_, k) => (k === 0 ? "1" : `${k + 1} * x^${k}`)).join(" + ");
    const poly8B = Array.from({ length: 9 }, (_, k) => (k === 0 ? "2" : `${k + 2} * x^${k}`)).join(" + ");
    const denseCross = verifyScalarEquivalence(`1 / (${poly8A})^8`, `2 / (${poly8B})^8`, {
      intervals: [{ left: 0, right: 1 }],
    });
    expect(denseCross.status).toBe("unverified");
    expect(denseCross.reason).toBe("polynomial_complexity_exceeded");

    const sparseDeg64Cross = verifyScalarEquivalence("1 / (((x^4)^4)^4 + 1)", "2 / (((x^4)^4)^4 + 2)", {
      intervals: [{ left: 0, right: 1 }],
    });
    expect(sparseDeg64Cross.status).toBe("unverified");
    expect(sparseDeg64Cross.reason).toBe("polynomial_complexity_exceeded");

    const cadCombinedExceeded = verifyScalarEquivalence(
      "sqrt((x^7)^5 + 1) * sqrt((x^7)^5 + 2)",
      "sqrt((x^7)^5 + 1) * sqrt((x^7)^5 + 2)",
    );
    expect(cadCombinedExceeded.status).toBe("unverified");
    expect(cadCombinedExceeded.reason).toBe("polynomial_complexity_exceeded");

    const sqrtNestedPow = verifyScalarEquivalence("sqrt((((x + 1)^12)^12)^12)", "sqrt((((x + 1)^12)^12)^12)");
    expect(sqrtNestedPow.status).toBe("unverified");
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

  it("enforces intermediate coefficient magnitude bounds before cancellation (P1-2)", () => {
    const huge = 1n << 4097n;
    const halfHuge = 1n << 4096n;
    expect(() => polynomialAdd(new Map([[0, rational(huge)]]), new Map([[0, rational(-huge)]]))).toThrow(
      /polynomial_complexity_exceeded/,
    );
    expect(() => polynomialAdd(new Map([[1, rational(halfHuge)]]), new Map([[1, rational(halfHuge)]]))).toThrow(
      /polynomial_complexity_exceeded/,
    );

    const directConst = rationalForm({ kind: "const", value: rational(huge) }, "x");
    expect(directConst.unsupported).toBe("polynomial_complexity_exceeded");

    const hugeMulCancel = verifyScalarEquivalence(
      {
        kind: "sub",
        left: {
          kind: "mul",
          left: { kind: "const", value: rational(halfHuge) },
          right: { kind: "mul", left: { kind: "const", value: 2 }, right: { kind: "variable", name: "x" } },
        },
        right: {
          kind: "mul",
          left: { kind: "const", value: rational(huge) },
          right: { kind: "variable", name: "x" },
        },
      },
      "0",
    );
    expect(hugeMulCancel.status).toBe("unverified");
    expect(hugeMulCancel.reason).toBe("polynomial_complexity_exceeded");

    const nestedConstCancel = verifyScalarEquivalence("(((2^12)^12)^12)^12 - (((2^12)^12)^12)^12", "0");
    expect(nestedConstCancel.status).toBe("unverified");
    expect(nestedConstCancel.reason).toBe("polynomial_complexity_exceeded");
  });

  it("preserves base != 0 domain constraints on zero exponents (P1-3)", () => {
    const onSingletonZero = verifyScalarEquivalence("(x - 1)^0", "1", {
      intervals: [{ left: 1, right: 1 }],
    });
    expect(onSingletonZero.status).toBe("inequivalent");
    expect(onSingletonZero.reason).toBe("natural_domain_mismatch");

    const onReals = verifyScalarEquivalence("(x - 1)^0", "1");
    expect(onReals.status).toBe("inequivalent");
    expect(onReals.reason).toBe("natural_domain_mismatch");

    expect(verifyScalarEquivalence("(x - 1)^0", "1", { excluded: [1] }).status).toBe("equivalent");
    expect(
      verifyScalarEquivalence("(x - 1)^0", "1", { intervals: [{ left: 1, leftOpen: true }] }).status,
    ).toBe("equivalent");
    expect(verifyScalarEquivalence("2^0", "1").status).toBe("equivalent");
    expect(verifyScalarEquivalence("(1 - 1)^0", "1").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("(1 - 1)^0", "1").reason).toBe("natural_domain_mismatch");
    expect(verifyScalarEquivalence("exp(x)^0", "1").status).toBe("equivalent");
  });

  it("normalizes LaTeX brace implicit multiplication and guards non-commutative matrix algebra", () => {
    expect(normalizeLatexExpr("x^{ab}")).toBe("x^(a*b)");
    expect(normalizeLatexExpr("x_{ab}")).toBe("x_ab");
    expect(normalizeLatexExpr("x_{a+b}")).toBeNull();
    expect(normalizeLatexExpr("x^{2y}")).toBe("x^(2*y)");
    expect(normalizeLatexExpr("\\sqrt{2x}")).toBe("sqrt(2*x)");
    expect(normalizeLatexExpr("\\sqrt[3]{x}")).toBeNull();
    expect(normalizeLatexExpr("\\frac{x^{2}-1}{x-1}")).toBe("((x^(2)-1)/(x-1))");
    expect(normalizeLatexExpr("\\ln 0.5")).toBe("ln(0.5)");
    expect(normalizeLatexExpr("\\sin^{2}(x)")).toBe("((sin(x))^(2))");
    expect(normalizeLatexExpr("\\sin^{-1}(x)")).toBeNull();
    expect(normalizeLatexExpr("\\sin^2 x")).toBeNull();
    expect(normalizeLatexExpr("\\ln xy")).toBeNull();
    expect(normalizeLatexExpr("\\sin 2x")).toBeNull();
    expect(normalizeLatexExpr("\\sin x^2")).toBeNull();
    expect(normalizeLatexExpr("asin(x)")).toBe("asin(x)");
    expect(normalizeLatexExpr("det(A)")).toBe("det(A)");

    expect(
      verifyScalarEquivalence("\\frac{x^{2}-1}{x-1}", "x + 1", {
        excluded: [1],
      }).status,
    ).toBe("equivalent");

    // Round-12 P1-1: unbraced multi-digit/multi-char LaTeX args must not turn into false products
    expect(verifyScalarEquivalence("\\ln 10", "0").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("\\sqrt 16", "6").status).toBe("inequivalent");
    expect(verifyScalarEquivalence("\\sin 2x", "x * sin(2)").status).toBe("unverified");
    expect(verifyScalarEquivalence("\\sin^{2}(x)", "(sin(x))^2").status).toBe("equivalent");
    expect(verifyScalarEquivalence("\\cos^2{x}", "(cos(x))^2").status).toBe("equivalent");

    // Round-12 P1-2: preserve unknown function calls, multi-letter variables, subscripts, and symmetric matrix normalization
    expect(verifyScalarEquivalence("det(A) + \\frac{0}{1}", "d*e*t*A").status).toBe("unverified");
    expect(verifyScalarEquivalence("asin(x) + \\frac{0}{1}", "a*sin(x)").status).toBe("unverified");
    expect(verifyScalarEquivalence("tan(x) + \\frac{0}{1}", "t*a*n*x").status).toBe("unverified");
    expect(verifyScalarEquivalence("theta + \\frac{0}{1}", "t*h*e*t*a").status).toBe("unverified");
    expect(verifyScalarEquivalence("\\theta + \\frac{\\theta}{2}", "3 * theta / 2", { variable: "theta" }).status).toBe(
      "equivalent",
    );
    expect(verifyScalarEquivalence("x_{ab} + 1", "1 + x_ab", { variable: "x_ab" }).status).toBe("equivalent");

    expect(verifyMatrixExpressionEquivalence("A*(B - C)", "A*B - A*C").status).toBe("equivalent");
    expect(verifyMatrixExpressionEquivalence("A(B + C)", "AB + AC").status).toBe("equivalent");
    expect(verifyMatrixExpressionEquivalence("AB", "BA")).toMatchObject({
      status: "inequivalent",
      reason: "non_commutative_mismatch",
    });
    expect(verifyMatrixExpressionEquivalence("det(A)", "d*e*t*A").status).toBe("unverified");
    expect(verifyMatrixExpressionEquivalence("tr(A*B)", "tr(B*A)").status).toBe("unverified");
    expect(verifyMatrixExpressionEquivalence("A*B", "A*B", { intervals: [{ left: "bad" }] })).toMatchObject({
      status: "unverified",
      reason: "invalid_domain",
    });

    const swapped = verifyMatrixExpressionEquivalence("A*(B - C)", "(B - C)*A");
    expect(swapped.status).toBe("inequivalent");
    expect(swapped.reason).toBe("non_commutative_mismatch");

    const scalarScoped = verifyScalarEquivalence("A*(B - C)", "(B - C)*A", {
      nonCommutativeVars: ["A", "B", "C"],
    });
    expect(scalarScoped.status).toBe("inequivalent");
    expect(scalarScoped.reason).toBe("non_commutative_mismatch");

    expect(verifyMatrixExpressionEquivalence("(A + B)^2", "A^2 + A*B + B*A + B^2").status).toBe("equivalent");
    expect(verifyMatrixExpressionEquivalence("(A + B)^2", "A^2 + 2*A*B + B^2").reason).toBe(
      "non_commutative_mismatch",
    );

    // Round-12 P1-3 & P2: complete magnitude & overflow bounds, 0^0 exponent rejection
    const bigB = "(((2^12)^12)^12)^3";
    const sinZeroCancel = verifyScalarEquivalence(`sin(0) + ${bigB} - ${bigB}`, "0");
    expect(sinZeroCancel.status).toBe("unverified");
    expect(sinZeroCancel.reason).toBe("polynomial_complexity_exceeded");

    const sinVarCancel = verifyScalarEquivalence(`sin(x) + ${bigB} - ${bigB}`, "sin(x)");
    expect(sinVarCancel.status).toBe("unverified");
    expect(sinVarCancel.reason).toBe("polynomial_complexity_exceeded");

    const pow2_2100 = "(((2^12)^12)^12) * (((2^10)^6)^6) * (2^12)";
    const pow3_1331 = "((3^11)^11)^11";
    const bigDenLcm = verifyScalarEquivalence(
      `ln((1 / (${pow2_2100})) * sin(x) + (1 / (${pow3_1331})) * cos(x))`,
      `ln(sin(x))`,
    );
    expect(bigDenLcm.status).toBe("unverified");

    const bigDiv = verifyScalarEquivalence(
      {
        kind: "div",
        left: { kind: "const", value: rational(1n << 4096n) },
        right: { kind: "const", value: rational(1n, 2n) },
      },
      "0",
    );
    expect(bigDiv.status).toBe("unverified");
    expect(bigDiv.reason).toBe("polynomial_complexity_exceeded");

    const simplifiedHuge = simplifyRadical({
      kind: "div",
      left: { kind: "const", value: rational(1n << 4096n) },
      right: { kind: "const", value: rational(1n, 2n) },
    });
    expect(simplifiedHuge.kind).toBe("div");

    const zeroPowZeroExp = verifyScalarEquivalence("x^(0^0)", "x");
    expect(zeroPowZeroExp.status).toBe("unverified");
    expect(zeroPowZeroExp.reason).toBe("parse_outside_decidable_fragment");

    // Round-13 P1-2: exact Horner & scalar evaluation magnitude cap at x = 2^3000
    const x2_3000 = (1n << 3000n).toString();
    const hornerZero = verifyScalarEquivalence("x^2", "0", {
      intervals: [{ left: x2_3000, right: x2_3000 }],
    });
    expect(hornerZero.status).toBe("unverified");
    expect(hornerZero.reason).toBe("polynomial_complexity_exceeded");

    const hornerSelf = verifyScalarEquivalence("x^2", "x^2", {
      intervals: [{ left: x2_3000, right: x2_3000 }],
    });
    expect(hornerSelf.status).toBe("unverified");
    expect(hornerSelf.reason).toBe("polynomial_complexity_exceeded");

    // Round-13 P1-3: empty locked domain must not misreport 0^0 vs (x-1)^0 or 1/0 vs 1/(x-1) as inequivalent
    expect(verifyScalarEquivalence("0^0", "(x - 1)^0", { intervals: [{ left: 1, right: 1 }] }).status).toBe("unverified");
    expect(verifyScalarEquivalence("1 / 0", "1 / (x - 1)", { intervals: [{ left: 1, right: 1 }] }).status).toBe(
      "unverified",
    );
    expect(verifyScalarEquivalence("0^0", "(x - 1)^0", { intervals: [{ left: 0, right: 2 }] }).status).toBe(
      "inequivalent",
    );

    // Round-13 P1-4: matrix / non-commutative comparator honors scalar domain restrictions & empty scalar domains
    expect(
      verifyScalarEquivalence("x * A", "A", {
        variable: "x",
        nonCommutativeVars: ["A"],
        intervals: [{ left: 1, right: 1 }],
      }).status,
    ).toBe("equivalent");
    expect(
      verifyScalarEquivalence("abs(x) * A", "x * A", {
        variable: "x",
        nonCommutativeVars: ["A"],
        intervals: [{ left: 0, right: 5 }],
      }).status,
    ).toBe("equivalent");
    expect(
      verifyScalarEquivalence("x * A", "2 * A", {
        variable: "x",
        nonCommutativeVars: ["A"],
        intervals: [{ left: 1, right: 1 }],
      }).status,
    ).toBe("inequivalent");
    expect(
      verifyScalarEquivalence("(0^0) * A", "((x - 1)^0) * A", {
        variable: "x",
        nonCommutativeVars: ["A"],
        intervals: [{ left: 1, right: 1 }],
      }).status,
    ).toBe("unverified");
    expect(
      verifyMatrixExpressionEquivalence("(1 / (x - 1)) * A", "A", {
        variable: "x",
        nonCommutativeVars: ["A"],
        intervals: [{ left: 1, right: 1 }],
      }).status,
    ).toBe("unverified");

    // Round-13 P2: declared matrix/scalar identifiers permit implicit multiplication before parentheses while unknown fns fail closed
    expect(
      verifyScalarEquivalence("A(B - C)", "A*B - A*C", {
        nonCommutativeVars: ["A", "B", "C"],
      }).status,
    ).toBe("equivalent");
    expect(
      verifyScalarEquivalence("A(B - C)", "(B - C)A", {
        nonCommutativeVars: ["A", "B", "C"],
      }).status,
    ).toBe("inequivalent");
    expect(
      verifyMatrixExpressionEquivalence("A\\left(B + C\\right)", "AB + AC", {
        nonCommutativeVars: ["A", "B", "C"],
      }).status,
    ).toBe("equivalent");
    expect(verifyScalarEquivalence("foo(x)", "foo * x").status).toBe("unverified");
    expect(verifyMatrixExpressionEquivalence("foo(x)", "foo * x", { nonCommutativeVars: ["A"] }).status).toBe(
      "unverified",
    );

    // Round-14 P1-1: matrix AST weight + constant folding prevents exponential DAG blowup
    const tMatrixConstStart = performance.now();
    expect(verifyMatrixExpressionEquivalence("((A + 1)^10)^4", "(A + 1)^10 * (A + 1)^10 * (A + 1)^10 * (A + 1)^10").status).toBe("equivalent");
    expect(performance.now() - tMatrixConstStart).toBeLessThan(200);

    const tMatrixSymbolicStart = performance.now();
    const matrixSymbolicOverflow = verifyMatrixExpressionEquivalence("((A + x)^12)^5", "A^60", {
      variable: "x",
      nonCommutativeVars: ["A"],
    });
    expect(matrixSymbolicOverflow.status).toBe("unverified");
    expect(matrixSymbolicOverflow.reason).toBe("polynomial_complexity_exceeded");
    expect(performance.now() - tMatrixSymbolicStart).toBeLessThan(200);

    // Round-14 P1-1: shared ScalarExpr DAG defense-in-depth in scalar equivalence, differentiate, and simplifyRadical
    let sharedDag: ScalarExpr = { kind: "variable", name: "x" };
    for (let i = 0; i < 35; i++) {
      sharedDag = { kind: "add", left: sharedDag, right: sharedDag };
    }
    const tDagStart = performance.now();
    const dagScalarRes = verifyScalarEquivalence(sharedDag, sharedDag);
    expect(dagScalarRes.status).toBe("unverified");
    expect(dagScalarRes.reason).toBe("polynomial_complexity_exceeded");
    expect(differentiate(sharedDag)).toBeNull();
    expect(simplifyRadical(sharedDag)).toBe(sharedDag);
    expect(performance.now() - tDagStart).toBeLessThan(200);

    // Round-14 P1-2: oversized integer/decimal inputs never throw uncaught PolyComplexityError from exported entrypoints
    const hugeDigits = "9".repeat(2000);
    expect(parseScalarExpr(`2^${hugeDigits}`)).toBeNull();
    expect(verifyScalarEquivalence(hugeDigits, hugeDigits)).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(evaluateScalar({ kind: "const", value: hugeDigits }, rational(0n))).toEqual({
      defined: false,
      reason: "polynomial_complexity_exceeded",
    });
    expect(rationalForm({ kind: "const", value: hugeDigits }).unsupported).toBe("polynomial_complexity_exceeded");
    expect(verifyIndefiniteIntegral({ student: `${hugeDigits} * x`, integrand: hugeDigits })).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(
      verifySubstitutionBounds({
        lower: 0,
        upper: 1,
        substitution: "x",
        transformedLower: hugeDigits,
        transformedUpper: "1",
      }),
    ).toMatchObject({ status: "unverified", reason: "polynomial_complexity_exceeded" });
    expect(simplifyRadical({ kind: "const", value: hugeDigits })).toEqual({ kind: "const", value: hugeDigits });
    expect(verifyMatrixExpressionEquivalence(hugeDigits, hugeDigits).status).toBe("unverified");
    expect(
      verifyMatrixExpressionEquivalence("A", "A", {
        variable: "x",
        nonCommutativeVars: ["A"],
        excluded: [hugeDigits],
      }),
    ).toMatchObject({ status: "unverified", reason: "polynomial_complexity_exceeded" });
    expect(differentiate({ kind: "const", value: hugeDigits })).toEqual({ kind: "const", value: 0 });

    // Round-14 P2-2: whole-expression joint scalar domain checking in matrix / non-commutative verification
    expect(
      verifyMatrixExpressionEquivalence("(1 / (x - 1)) * A + B", "(1 / (x - 1)) * A + ((x - 1) / (x - 1)) * B", {
        variable: "x",
        nonCommutativeVars: ["A", "B"],
      }).status,
    ).toBe("equivalent");
    expect(
      verifyMatrixExpressionEquivalence("(1 / (x - 1)) * A + B", "A + B", {
        variable: "x",
        nonCommutativeVars: ["A", "B"],
      }),
    ).toMatchObject({ status: "inequivalent", reason: "natural_domain_mismatch" });
    expect(
      verifyMatrixExpressionEquivalence("(1 / (x^2 - 2)) * A + B", "(1 / (x^2 - 2)) * A + ((x^2 - 2) / (x^2 - 2)) * B", {
        variable: "x",
        nonCommutativeVars: ["A", "B"],
      }).status,
    ).toBe("equivalent");
    expect(
      verifyMatrixExpressionEquivalence("sqrt(x) * A + abs(x) * B", "sqrt(x) * A + x * B", {
        variable: "x",
        nonCommutativeVars: ["A", "B"],
      }).status,
    ).toBe("equivalent");

    // Round-15 P1-2: mixed rational + transcendental matrix expressions with shared irrational domain holes
    expect(
      verifyMatrixExpressionEquivalence(
        "A / (x^2 - 2) + sin(x) * C + B",
        "A / (x^2 - 2) + sin(x) * C + ((x^2 - 2) / (x^2 - 2)) * B",
        {
          variable: "x",
          nonCommutativeVars: ["A", "B", "C"],
          intervals: [{ left: 1, right: 2 }],
        },
      ).status,
    ).toBe("equivalent");
    expect(
      verifyMatrixExpressionEquivalence(
        "A / (x^2 - 2) + sin(x) * C + B",
        "A / (x^2 - 2) + sin(x) * C + 2 * B",
        {
          variable: "x",
          nonCommutativeVars: ["A", "B", "C"],
          intervals: [{ left: 1, right: 2 }],
        },
      ).status,
    ).toBe("inequivalent");
    expect(
      verifyMatrixExpressionEquivalence(
        "A / (x^2 - 2) + sin(x) * C + B",
        "sin(x) * C + B",
        {
          variable: "x",
          nonCommutativeVars: ["A", "B", "C"],
          intervals: [{ left: 1, right: 2 }],
        },
      ),
    ).toMatchObject({ status: "inequivalent", reason: "natural_domain_mismatch" });
    const sharedIrrationalTranscendental = verifyMatrixExpressionEquivalence(
      "A / (x^2 - 2) + sin(x) * B",
      "A / (x^2 - 2) + sin(x) * ((x^2 - 2) / (x^2 - 2)) * B",
      {
        variable: "x",
        nonCommutativeVars: ["A", "B"],
        intervals: [{ left: 1, right: 2 }],
      },
    );
    expect(["equivalent", "unverified"]).toContain(sharedIrrationalTranscendental.status);

    // Round-15 P1-3: deep nesting/recursion depth cap prevents stack overflow (RangeError)
    const tDeepNestStart = performance.now();
    const deepParens = `${"(".repeat(20_000)}x${")".repeat(20_000)}`;
    const deepMatrixParens = `${"(".repeat(20_000)}A${")".repeat(20_000)}`;
    const deepLeftParens = `${"\\left(".repeat(20_000)}x${"\\right)".repeat(20_000)}`;
    const deepBraces = `${"{".repeat(20_000)}x${"}".repeat(20_000)}`;
    const deepUnary = `${"-".repeat(20_000)}x`;
    expect(verifyScalarEquivalence(deepParens, "x")).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(verifyScalarEquivalence(deepUnary, "x")).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(verifyMatrixExpressionEquivalence(deepMatrixParens, "A")).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(parseScalarExpr(deepParens)).toBeNull();
    expect(parseScalarExpr(deepLeftParens)).toBeNull();
    expect(normalizeLatexExpr(deepBraces)).toBeNull();
    expect(performance.now() - tDeepNestStart).toBeLessThan(200);
  });

  it("closes Round-16 matrix/joint-domain witness, LaTeX matrix literals, and deep flat-chain stack guards", () => {
    // Round-16 P1-2 Issue A: const word differences check positively defined domain sites instead of hardcoded x = 0
    expect(
      verifyMatrixExpressionEquivalence("A / x + sin(x) * C + B", "A / x + sin(x) * C + 2 * B", {
        variable: "x",
        nonCommutativeVars: ["A", "B", "C"],
        intervals: [{ left: 1, right: 2 }],
      }).status,
    ).toBe("inequivalent");
    expect(
      verifyMatrixExpressionEquivalence("A / x + sin(x) * C + B", "(A + B * x) / x + sin(x) * C", {
        variable: "x",
        nonCommutativeVars: ["A", "B", "C"],
        intervals: [{ left: 1, right: 2 }],
      }).status,
    ).toBe("equivalent");

    // Round-16 P1-2 Mid-turn steer: disjoint non-rational domains fail closed unverified instead of inequivalent/equivalent
    const disjointNonRatDiff = verifyMatrixExpressionEquivalence(
      "sqrt((x^2 - 6) * (x - 1)) * A + sqrt(cos(x) + 3 / 4) * C + B",
      "sqrt((x^2 - 6) * (x - 1)) * A + sqrt(cos(x) + 3 / 4) * C + 2 * B",
      {
        variable: "x",
        nonCommutativeVars: ["A", "B", "C"],
        intervals: [{ left: 2, right: 3 }],
      },
    );
    expect(disjointNonRatDiff.status).toBe("unverified");
    const disjointNonRatSame = verifyMatrixExpressionEquivalence(
      "sqrt((x^2 - 6) * (x - 1)) * A + sqrt(cos(x) + 3 / 4) * C + B",
      "sqrt((x^2 - 6) * (x - 1)) * A + sqrt(cos(x) + 3 / 4) * C + B",
      {
        variable: "x",
        nonCommutativeVars: ["A", "B", "C"],
        intervals: [{ left: 2, right: 3 }],
      },
    );
    expect(disjointNonRatSame.status).toBe("unverified");

    // Round-16 P1-2 Issue B: LaTeX pmatrix/bmatrix/matrix/vmatrix literals & joint-domain verification
    expect(
      verifyMatrixExpressionEquivalence(
        "\\begin{pmatrix} 1/(x-2) & \\sin(x) \\end{pmatrix}",
        "\\begin{pmatrix} x/(x^2-2x) & \\sin(x) \\end{pmatrix}",
      ),
    ).toMatchObject({
      status: "inequivalent",
      reason: "natural_domain_mismatch",
    });
    expect(
      verifyScalarEquivalence(
        "\\begin{pmatrix} 1/(x-2) & \\sin(x) \\end{pmatrix}",
        "\\begin{pmatrix} x/(x^2-2x) & \\sin(x) \\end{pmatrix}",
      ),
    ).toMatchObject({
      status: "inequivalent",
      reason: "natural_domain_mismatch",
    });
    expect(
      verifyMatrixExpressionEquivalence(
        "\\begin{pmatrix} 1/(x-2) & \\sin(x) \\end{pmatrix}",
        "\\begin{pmatrix} x/(x^2-2x) & \\sin(x) \\end{pmatrix}",
        { intervals: [{ left: 3, right: 4 }] },
      ).status,
    ).toBe("equivalent");
    expect(
      verifyScalarEquivalence(
        "\\begin{pmatrix} 1/(x-2) & \\sin(x) \\end{pmatrix}",
        "\\begin{pmatrix} x/(x^2-2x) & \\sin(x) \\end{pmatrix}",
        { intervals: [{ left: 3, right: 4 }] },
      ).status,
    ).toBe("equivalent");
    expect(
      verifyMatrixExpressionEquivalence(
        "2 * \\begin{bmatrix} x & 1 \\end{bmatrix} + \\begin{matrix} 1 & x \\end{matrix}",
        "\\begin{pmatrix} 2*x + 1 & x + 2 \\end{pmatrix}",
      ).status,
    ).toBe("equivalent");
    expect(
      verifyMatrixExpressionEquivalence(
        "\\begin{pmatrix} 1 & x \\\\ 0 & 1 \\end{pmatrix} * \\begin{pmatrix} 2 \\\\ 3 \\end{pmatrix}",
        "\\begin{pmatrix} 2 + 3*x \\\\ 3 \\end{pmatrix}",
      ).status,
    ).toBe("equivalent");
    expect(
      verifyMatrixExpressionEquivalence(
        "\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}",
        "d*a - c*b",
      ).status,
    ).toBe("equivalent");
    expect(
      verifyScalarEquivalence(
        "\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}",
        "a*d - b*c",
      ).status,
    ).toBe("equivalent");
    expect(
      verifyMatrixExpressionEquivalence(
        "\\begin{pmatrix} 1 & 2 \\end{pmatrix}",
        "\\begin{pmatrix} 1 \\\\ 2 \\end{pmatrix}",
      ),
    ).toMatchObject({
      status: "inequivalent",
      reason: "matrix_dimension_mismatch",
    });

    // Round-16 P1-3: long flat chains and programmatic 20,000-deep ScalarExpr chains never overflow call stack
    const longSum = Array(20_000).fill("x").join("+");
    const longProd = Array(20_000).fill("x").join("*");
    expect(verifyScalarEquivalence(longSum, "x")).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(verifyScalarEquivalence(longProd, "x")).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(parseScalarExpr(longSum)).toBeNull();
    expect(parseScalarExpr(longProd)).toBeNull();

    let deepSumAst: ScalarExpr = { kind: "variable", name: "x" };
    for (let i = 0; i < 20_000; i++) {
      deepSumAst = { kind: "add", left: deepSumAst, right: { kind: "const", value: 1 } };
    }
    expect(verifyScalarEquivalence(deepSumAst, "x")).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(verifyMatrixExpressionEquivalence(deepSumAst, "A", { nonCommutativeVars: ["A"] })).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(differentiate(deepSumAst, "x")).toBeNull();
    expect(simplifyRadical(deepSumAst)).toBe(deepSumAst);

    // Round-17 P1-2: multivariate LaTeX matrices evaluate all cells simultaneously at each sample point
    expect(
      verifyMatrixExpressionEquivalence(
        "\\begin{pmatrix} 1/(x-x) & y \\end{pmatrix}",
        "\\begin{pmatrix} 1/(x-x) & y+1 \\end{pmatrix}",
      ).status,
    ).toBe("unverified");
    expect(
      verifyMatrixExpressionEquivalence(
        "\\begin{pmatrix} 1/(x-x) & y \\end{pmatrix}",
        "\\begin{pmatrix} 1/(x-x) & y \\end{pmatrix}",
      ).status,
    ).toBe("unverified");
    expect(
      verifyMatrixExpressionEquivalence(
        "\\begin{pmatrix} 1/(x-1) & y \\end{pmatrix}",
        "\\begin{pmatrix} 1/(x-1) & y+1 \\end{pmatrix}",
      ).status,
    ).toBe("inequivalent");
    expect(
      verifyMatrixExpressionEquivalence(
        "\\begin{pmatrix} 1/(x-1) & y \\end{pmatrix}",
        "\\begin{pmatrix} x/(x^2-x) & y \\end{pmatrix}",
      ),
    ).toMatchObject({
      status: "inequivalent",
      reason: "natural_domain_mismatch",
    });
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
    expect(verifyNullspace([[1, 0], [0, 1]], [[0, 0]]).status).toBe("inequivalent");
    expect(verifyNullspace([[1, 0], [0, 1]], [[1, 0]]).status).toBe("inequivalent");
    expect(verifyNullspace([[1, 1, 0]], [[1, -1, 0], [0, 0, 0]]).status).toBe("inequivalent");
    expect(verifyNullspace([[1, 1, 0]], [[1, -1, 0], [2, -2, 0]]).status).toBe("inequivalent");

    expect(verifyEigenspace({ matrix: [[2, 0], [0, 2]], eigenvalue: 2, vectors: [[1, 0], [0, 1]] }).status).toBe("equivalent");
    expect(verifyEigenspace({ matrix: [[2, 0], [0, 2]], eigenvalue: 2, vectors: [[1, 0]] }).status).toBe("inequivalent");
    expect(verifyEigenspace({ matrix: [[2, 0], [0, 2]], eigenvalue: 2, vectors: [[1, 0], [2, 0]] }).status).toBe("inequivalent");
    expect(verifyEigenspace({ matrix: [[2, 0], [0, 2]], eigenvalue: 3, vectors: [] }).status).toBe("inequivalent");
    expect(verifyEigenspace({ matrix: [[2, 1], [0, 2]], eigenvalue: 2, vectors: [[1, 0]] }).status).toBe("equivalent");

    // Round-14 P1-2: subspace / RREF / eigenspace entrypoints fail closed on > 4096-bit inputs and intermediate overflow
    const hugeDigits = "9".repeat(2000);
    const hugeBigint = 1n << 4097n;
    expect(rref([[hugeDigits]])).toBeNull();
    expect(findLinearDependency([[hugeDigits]])).toBeNull();
    expect(verifySubspaceEquality([[hugeDigits]], [[1]])).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(verifySubspaceBasis([[hugeBigint]], [[1]])).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(verifyNullspace([[hugeDigits]], [])).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
    expect(verifyEigenspace({ matrix: [[1]], eigenvalue: hugeDigits, vectors: [[1]] })).toMatchObject({
      status: "unverified",
      reason: "polynomial_complexity_exceeded",
    });
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

    // Round-6 P1-6: actual cloned heap + variable footprint counted in 8 MiB trace ceiling
    const traceHeapBlast = runCSubset408({
      instructions: [
        { op: "alloc", target: "arr", length: 60_000 },
        { op: "const", target: "i", value: 0 },
        { op: "binary", target: "i", operator: "+", left: { variable: "i" }, right: 1 },
        { op: "binary", target: "cont", operator: "<", left: { variable: "i" }, right: 20 },
        { op: "branch", condition: { variable: "cont" }, ifTrue: 2, ifFalse: 5 },
        { op: "return", value: { variable: "i" } },
      ],
    });
    expect(traceHeapBlast.status).toBe("unverified");
    if (traceHeapBlast.status === "unverified") expect(traceHeapBlast.reason).toBe("memory_limit_exceeded");
    expect(traceHeapBlast.trace.length).toBeLessThan(10);

    // Round-7 P1-B: free reclaims field string bytes and clears live field payloads while keeping use-after-free tombstones
    const payload = "x".repeat(4_000);
    const allocFreeLoop = runCSubset408({
      memoryBytes: 256_000,
      instructions: [
        { op: "const", target: "i", value: 0 },
        { op: "alloc", target: "p", fields: { payload } },
        { op: "free", pointer: { variable: "p" } },
        { op: "binary", target: "i", operator: "+", left: { variable: "i" }, right: 1 },
        { op: "binary", target: "cont", operator: "<", left: { variable: "i" }, right: 8 },
        { op: "branch", condition: { variable: "cont" }, ifTrue: 1, ifFalse: 6 },
        { op: "return", value: { variable: "i" } },
      ],
    });
    expect(allocFreeLoop.status).toBe("verified");
    if (allocFreeLoop.status === "verified") expect(allocFreeLoop.value).toBe(8);

    const freedUaf = runCSubset408({
      instructions: [
        { op: "alloc", target: "p", fields: { secretField: "abc" } },
        { op: "free", pointer: { variable: "p" } },
        { op: "field", target: "q", pointer: { variable: "p" }, field: "secretField" },
        { op: "load", target: "v", pointer: { variable: "q" } },
      ],
    });
    expect(freedUaf.status).toBe("unverified");
    if (freedUaf.status === "unverified") expect(freedUaf.reason).toBe("use_after_free");
    const postFreeSnapshot = freedUaf.trace.find((snap) => snap.op === "free" && snap.phase === "after");
    expect(postFreeSnapshot?.heap["1"]).toEqual({ generation: 2, live: false, fields: {} });

    // Round-8 P1-4: reject undeclared field load/store/field ops and reclaim exact allocated + dynamic bytes on free
    const undeclaredStore = runCSubset408({
      initial: { crafted: { objectId: 1, generation: 1, fieldOrIndex: "rogueKey".repeat(500) } },
      instructions: [
        { op: "alloc", target: "p", fields: { safe: 1 } },
        { op: "store", pointer: { variable: "crafted" }, value: 99 },
      ],
    });
    expect(undeclaredStore.status).toBe("unverified");
    if (undeclaredStore.status === "unverified") {
      expect(undeclaredStore.reason).toBe("out_of_bounds");
      expect(undeclaredStore.detail).toBe("undeclared_field");
    }

    const undeclaredLoad = runCSubset408({
      initial: { crafted: { objectId: 1, generation: 1, fieldOrIndex: "missing" } },
      instructions: [
        { op: "alloc", target: "p", fields: { safe: 1 } },
        { op: "load", target: "out", pointer: { variable: "crafted" } },
      ],
    });
    expect(undeclaredLoad.status).toBe("unverified");
    if (undeclaredLoad.status === "unverified") {
      expect(undeclaredLoad.reason).toBe("out_of_bounds");
      expect(undeclaredLoad.detail).toBe("undeclared_field");
    }

    const undeclaredFieldOp = runCSubset408({
      instructions: [
        { op: "alloc", target: "p", fields: { safe: 1 } },
        { op: "field", target: "q", pointer: { variable: "p" }, field: "missing" },
      ],
    });
    expect(undeclaredFieldOp.status).toBe("unverified");
    if (undeclaredFieldOp.status === "unverified") {
      expect(undeclaredFieldOp.reason).toBe("out_of_bounds");
      expect(undeclaredFieldOp.detail).toBe("undeclared_field");
    }

    const storeAndFreeLoop = runCSubset408({
      memoryBytes: 256_000,
      instructions: [
        { op: "const", target: "i", value: 0 },
        { op: "alloc", target: "p", fields: { payload: "a" } },
        { op: "field", target: "slot", pointer: { variable: "p" }, field: "payload" },
        { op: "store", pointer: { variable: "slot" }, value: payload },
        { op: "free", pointer: { variable: "p" } },
        { op: "binary", target: "i", operator: "+", left: { variable: "i" }, right: 1 },
        { op: "binary", target: "cont", operator: "<", left: { variable: "i" }, right: 8 },
        { op: "branch", condition: { variable: "cont" }, ifTrue: 1, ifFalse: 8 },
        { op: "return", value: { variable: "i" } },
      ],
    });
    expect(storeAndFreeLoop.status).toBe("verified");
    if (storeAndFreeLoop.status === "verified") expect(storeAndFreeLoop.value).toBe(8);

    // Round-9 P1-4: reject fractional/non-safe-integer numeric slot indices across load, store, and index
    const fractionalLoad = runCSubset408({
      initial: { ptr: { objectId: 1, generation: 1, fieldOrIndex: 0.5 } },
      instructions: [
        { op: "alloc", target: "arr", length: 2 },
        { op: "load", target: "out", pointer: { variable: "ptr" } },
      ],
    });
    expect(fractionalLoad.status).toBe("unverified");
    if (fractionalLoad.status === "unverified") expect(fractionalLoad.reason).toBe("out_of_bounds");

    const fractionalStore = runCSubset408({
      initial: { ptr: { objectId: 1, generation: 1, fieldOrIndex: 0.5 } },
      instructions: [
        { op: "alloc", target: "arr", length: 2 },
        { op: "store", pointer: { variable: "ptr" }, value: 42 },
      ],
    });
    expect(fractionalStore.status).toBe("unverified");
    if (fractionalStore.status === "unverified") expect(fractionalStore.reason).toBe("out_of_bounds");

    const fractionalIndex = runCSubset408({
      instructions: [
        { op: "alloc", target: "arr", length: 2 },
        { op: "index", target: "q", pointer: { variable: "arr" }, index: 0.5 },
      ],
    });
    expect(fractionalIndex.status).toBe("unverified");
    if (fractionalIndex.status === "unverified") expect(fractionalIndex.reason).toBe("out_of_bounds");

    const unsafeBigIndex = runCSubset408({
      initial: { ptr: { objectId: 1, generation: 1, fieldOrIndex: 1e20 } },
      instructions: [
        { op: "alloc", target: "arr", length: 2 },
        { op: "store", pointer: { variable: "ptr" }, value: 1 },
      ],
    });
    expect(unsafeBigIndex.status).toBe("unverified");
    if (unsafeBigIndex.status === "unverified") expect(unsafeBigIndex.reason).toBe("out_of_bounds");
  });
});
