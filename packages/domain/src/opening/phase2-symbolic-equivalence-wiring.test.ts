import type { AiGradingProposal, ProofFeedback } from "@aistudy/contracts";
import { describe, expect, it } from "vitest";
import { acceptedAiGradingOutcome } from "./ai-evaluation";
import { proofFeedbackAllowsOutcome } from "./proof-feedback";
import { verifyStandaloneProofEquationClaim, verifySymbolicStepEquivalence } from "./symbolic-answer-bridge";
import { evaluateTeachingAnswer as check } from "./teaching-answer-check";

const numeric = { kind: "numeric" as const };
const choice = (...labels: string[]) => ({
  kind: "choice" as const,
  options: labels.map((label, index) => ({ id: String.fromCharCode(65 + index), label })),
});
const algebra = "化简 $(x+1)^2 - 1$";
const quadratic = "x^2+2x";
const radical = String.raw`计算 $\sqrt{8} - \sqrt{2}$`;
const sqrtTwo = String.raw`\sqrt{2}`;

describe("symbolic teaching choice", () => {
  it("abstains when an unfenced distractor could render as a second correct option", () => {
    const stem = "Evaluate $\\sqrt{49}$";
    const distractor = "3\\!+1";
    expect(check(stem, choice("7", distractor), "A", "B. " + distractor)).toBeNull();
    expect(check(stem, choice("7", distractor), "A", "A. 7")).toBeNull();
    expect(check(stem, choice("7", "$" + distractor + "$"), "A", "B. $" + distractor + "$")).toBe("incorrect");
  });

  it.each(["\\!", "\\,", "\\;", "\\:", "\\+", "\\-", "\\/", "\\{", "\\}", "\\[", "\\]",
    "\\(", "\\)", "\\|", "\\^", "\\_", "\\$", "\\\\", "\\~", "\\ ", "~"])(
    "abstains on unfenced punctuation escape or spacing %j in a stem, candidate, or proof",
    escape => {
      const expression = "3" + escape + "+1";
      expect(check("Evaluate " + expression, numeric, "4", "4")).toBeNull();
      expect(check("Evaluate $sqrt(16)$", numeric, "4", expression)).toBe("unparseable");
      expect(verifySymbolicStepEquivalence({ kind: "scalar", reference: expression, student: "4" })).toBe("unverified");
      expect(verifyStandaloneProofEquationClaim(expression + " = 4").status).toBe("unverified");
    },
  );

  it("uses TeX spacing only inside a fenced calculus operand", () => {
    const integral = "\\int (3\\!+1)\\,dx";
    const derivative = "\\frac{d}{dx}((3\\!+1)x)";
    const interaction = choice("4x+C", "7x+C");
    expect(check("Evaluate " + integral, interaction, "A", "A. 4x+C")).toBeNull();
    expect(check("Evaluate $" + integral + "$", interaction, "A", "A. 4x+C")).toBe("correct");
    expect(verifyStandaloneProofEquationClaim(integral + " = 4x+C").status).toBe("unverified");
    expect(verifyStandaloneProofEquationClaim("$" + integral + " = 4x+C$").status).toBe("equivalent");
    expect(check("Differentiate " + derivative, numeric, "4", "4")).toBeNull();
    expect(check("Differentiate $" + derivative + "$", numeric, "4", "4")).toBe("correct");
    expect(verifyStandaloneProofEquationClaim("\\frac{d}{dx}(3\\!+1)x = 4").status).toBe("unverified");
  });

  it.each(["\\!", "\\;", "\\:", "\\ ", "\\,\\,"])(
    "rejects %j before an unfenced integral differential", separator => {
      const integral = "\\int 3" + separator + "dx";
      const interaction = choice("3x+C", "4x+C");
      expect(check("Evaluate " + integral, interaction, "A", "A. 3x+C")).toBeNull();
      expect(verifyStandaloneProofEquationClaim(integral + " = 3x+C").status).toBe("unverified");
      expect(check("Evaluate $" + integral + "$", interaction, "A", "A. 3x+C")).toBe("correct");
    },
  );

  it("allows an unfenced integral's final thin space and escaped literal multiplication", () => {
    const interaction = choice("x^2+C", "x^3+C");
    expect(check("Evaluate \\int 2\\*x \\, d x?", interaction, "A", "A. x^2+C")).toBe("correct");
    expect(verifyStandaloneProofEquationClaim("\\int 2\\*x \\, d x = x^2+C").status).toBe("equivalent");
    expect(check("Evaluate sqrt(4) \\* 3", numeric, "6", "6")).toBe("correct");
  });

  it.each(["A. 3", "A. 2 = 3", "A. 2x = 3x", "（A）：3"])(
    "rejects a contradictory arithmetic key suffix %s", key => {
      expect(check("Calculate 1+1", choice("2", "3"), key, "A. 2")).toBeNull();
    },
  );

  it.each(["A", "A. 2", "A. 1+1 = 2", "(A)：2"])("checks an arithmetic key %s", key => {
    expect(check("Calculate 1+1", choice("2", "3"), key, "A. 2")).toBe("correct");
  });

  it.each([
    [algebra, quadratic, "x^2+1"],
    ["展开 $(x+1)(x-1)$", "x^2-1", "x^2+1"],
    ["Simplify $(x+2)^2 - 4x$", "x^2+4", "x^2+1"],
    [radical, sqrtTwo, String.raw`\sqrt{3}`],
    [String.raw`求导 $\frac{d}{dt}(t^3 - 3t)$`, "3t^2-3", "t^2"],
    [String.raw`Differentiate $\sin(x) + x^2$`, "cos(x)+2x", "sin(x)+2x"],
    [String.raw`求不定积分 $\int 2x\,dx$`, "x^2+C", "x^3+C"],
    [String.raw`Evaluate $\int \cos(x)\,dx$`, "sin(x)+C", "cos(x)+C"],
  ])("checks the supported family for %s", (stem, right, wrong) => {
    const interaction = choice(right, wrong);
    expect(check(stem, interaction, "A", "A. " + right)).toBe("correct");
    expect(check(stem, interaction, "答案：" + right, "B. " + wrong)).toBe("incorrect");
    expect(check(stem, interaction, "B: " + right, "A. " + right)).toBeNull();
    expect(check(stem, interaction, "A", "A." + right)).toBe("unparseable");
  });

  it("corroborates every expression in a key chain", () => {
    const interaction = choice(quadratic, "x^2+1");
    expect(check(algebra, interaction, "答案：$(x+1)^2-1 = x^2+2x$", "A. " + quadratic)).toBe("correct");
    expect(check(algebra, interaction, "答：x^2+2x=x^2+1=x^2+2x", "A. " + quadratic)).toBeNull();
    expect(check(algebra, interaction, "Answer: 1/0", "A. " + quadratic)).toBeNull();
  });

  it.each(["A. 3x", "A. 2x = 3x", "(A) 2x = 3x", "（A）： 3x"])(
    "rejects an otherwise matching saved ID with a contradictory suffix %s", key => {
      expect(check("Simplify $x+x$", choice("2x", "3x"), key, "A. 2x")).toBeNull();
    },
  );

  it.each(["A", "A． $2x$", "A. $x+x$ = $2x$", "（A）： 2x", "(A). $$x+x=2x$$"])(
    "corroborates a symbolic key suffix after a matching ID %s", key => {
      expect(check("Simplify $x+x$", choice("2x", "3x"), key, "A. 2x")).toBe("correct");
    },
  );

  it.each([["B", "B.1", "B.1"], ["A", "A)", "(A)"]])("rejects overlapping saved IDs %s and %s", (first, second, key) => {
    const options = [{ id: first, label: quadratic }, { id: second, label: "x^2+1" }];
    for (const ordered of [options, [...options].reverse()]) {
      expect(check(algebra, { kind: "choice", options: ordered }, key, first + ". " + quadratic)).toBeNull();
    }
  });

  it.each(["(x+1)^2-1", "y^2", "(x+1)^1000", "1/(x-x)", "no answer"])("abstains with distractor %s", label => {
    expect(check(algebra, choice(quadratic, label), "A", "A. " + quadratic)).toBeNull();
  });

  it("compares the actual denominator roots before allowing cancellation", () => {
    const stem = "Simplify $(x^2-1)/(x-1)$";
    const sameDomain = "$(x+1)(x-1)/(x-1)$";
    expect(check(stem, choice("x+1", sameDomain), "A", "A. x+1")).toBeNull();
    expect(check(stem, choice("x+1", sameDomain), "B", "A. x+1")).toBe("incorrect");
    expect(check(stem, choice("x+1", sameDomain), "B", "B. " + sameDomain)).toBe("correct");
    expect(check(stem + String.raw` for $x \neq 1$`, choice("x+1", "x-1"), "x+1", "A. x+1")).toBe("correct");
    expect(check(stem + " (x != 1)", choice("x+1", "x-1"), "A", "A. x+1")).toBe("correct");
  });

  it("preserves the source domain when differentiating a logarithm", () => {
    expect(check("Differentiate $ln(x)$", choice("1/x", "2/x"), "A", "A. 1/x")).toBeNull();
    const interaction = choice("$1/x + 0*ln(x)$", "$2/x + 0*ln(x)$");
    expect(check("Differentiate $ln(x)$", interaction, "A", "A. $1/x + 0*ln(x)$")).toBe("correct");
    expect(check("Differentiate $1/x$", choice("-1/x^2", "1/x^2"), "A", "A. -1/x^2")).toBe("correct");
  });

  it("abstains when a formal derivative would discard points of the source domain", () => {
    const interaction = choice("2x^3/sqrt(x^4)", "2x");
    expect(check("Differentiate $sqrt(x^4)$", interaction, "A", "A. 2x^3/sqrt(x^4)")).toBeNull();
    expect(check("Differentiate $sqrt(x^4)$", interaction, "B", "B. 2x")).toBeNull();
    expect(check("Differentiate $sqrt(x^4)$ at $x=0$", numeric, "0", "0")).toBeNull();
    expect(check("Differentiate $1/x$ at $x=1$", numeric, "-1", "-1")).toBe("correct");
    const excludedRoot = choice("2x^3/sqrt(x^4)", "4x^3/sqrt(x^4)");
    expect(check("Differentiate $sqrt(x^4)$ for $x != 0$", excludedRoot, "A", "A. 2x^3/sqrt(x^4)")).toBe("correct");
    expect(verifySymbolicStepEquivalence({ kind: "derivative", reference: "abs(x)^2", student: "2x" })).toBe("unverified");
    const claim = "\\frac{d}{dx}(\\sqrt{x^4}) = 2x";
    expect(verifyStandaloneProofEquationClaim(claim).status).toBe("unverified");
    expect(adjudicate("correct", proof(claim, "correct"))).toBe("correct");
  });

  it.each([String.raw`求不定积分 $\int 2x$`, String.raw`求不定积分 $\int 2x\,dt$`, String.raw`Evaluate $\int_0^1 2x\,dx$`])(
    "does not infer indefinite integration from %s", stem => {
      expect(check(stem, choice("x^2+C", "x^3+C"), "A", "A. x^2+C")).toBeNull();
    },
  );

  it("requires an integral expression key to match the selected form", () => {
    const stem = String.raw`求不定积分 $\int 2x\,dx$`;
    expect(check(stem, choice("x^2+C", "x^3+C"), "x^2+1+C", "A. x^2+C")).toBeNull();
  });

  it.each(["x^2", "x^2 + C - C", "x^2 + 0*C", "x^2 + C - 2*C + C"])(
    "distinguishes an antiderivative family from %s", particular => {
      const stem = "\\int 2x\\,dx";
      const interaction = choice("x^2 + C", "$" + particular + "$");
      expect(check("Evaluate $" + stem + "$", interaction, "A", "A. x^2 + C")).toBe("correct");
      expect(check("Evaluate $" + stem + "$", interaction, "B", "B. $" + particular + "$")).toBeNull();
      expect(verifyStandaloneProofEquationClaim(stem + " = $" + particular + "$")).toEqual({
        status: "inequivalent", unconditional: false,
      });
      expect(verifySymbolicStepEquivalence({ kind: "indefinite-integral", reference: "2x", student: particular })).toBe("inequivalent");
    },
  );

  it("permits a nonzero rescaling of the arbitrary integration constant", () => {
    expect(verifySymbolicStepEquivalence({ kind: "indefinite-integral", reference: "2x", student: "x^2+C/2-C" })).toBe("equivalent");
  });

  it("abstains if formal differentiation loses a point of an alternative antiderivative", () => {
    const stem = String.raw`Evaluate $\int 2x\,dx$`;
    const alternative = String.raw`$\sqrt{x^4}+C$`;
    const interaction = choice("x^2+C", alternative);
    expect(check(stem, interaction, "A", "B. " + alternative)).toBeNull();
    expect(check(stem, interaction, "A", "A. x^2+C")).toBeNull();

    const wrongPower = choice("x^2+C", "x^3+C");
    expect(check(stem, wrongPower, "A", "A. x^2+C")).toBe("correct");
    expect(check(stem, wrongPower, "A", "B. x^3+C")).toBe("incorrect");
  });

  it("rejects an antiderivative with a removable hole inside the integrand domain", () => {
    const stem = String.raw`Evaluate $\int 2x\,dx$`;
    const interaction = choice("x^2+C", "x^3/x+C");
    expect(check(stem, interaction, "A", "A. x^2+C")).toBe("correct");
    expect(check(stem, interaction, "A", "B. x^3/x+C")).toBe("incorrect");
  });
});

describe("symbolic teaching numeric", () => {
  it.each([
    [sqrtTwo, "correct"], ["$sqrt(2)$", "correct"], ["2", "incorrect"],
    ["", "unparseable"], ["   ", "unparseable"], ["x", "unparseable"],
    ["2m", "unparseable"], ["2米", "unparseable"], ["2 is the answer", "unparseable"],
    ["1 2", "unparseable"], ["sqrt(", "unparseable"], ["1/(2-2)", "unparseable"],
    [String.raw`\sqrt{2}+1/(\sqrt{4}-2)`, "unparseable"],
  ])("grades exact constant submission %j as %s", (answer, expected) => {
    expect(check(radical, numeric, sqrtTwo, answer)).toBe(expected);
  });

  it.each([
    [String.raw`计算 $\sqrt{4}/6$`, "1/3"],
    ["Evaluate $cos(0)/3$", "cos(0)/3"],
    ["Evaluate $ln(exp(2))/6$", "ln(exp(2))/6"],
    ["Evaluate $abs(exp(ln(1/3)))$", "abs(exp(ln(1/3)))"],
    ["Evaluate $(sin(1)-sin(1)) + 1/3$", "(sin(1)-sin(1)) + 1/3"],
  ])("keeps the decimal rule for nonterminating exact results from %s", (stem, key) => {
    expect(check(stem, numeric, key, "0.3333")).toBe("unparseable");
    expect(check(stem, numeric, key, "2/6")).toBe("correct");
  });

  it("abstains on a decimal mismatch when the exact rational denominator is unresolved", () => {
    expect(check("Evaluate $exp(2)$", numeric, "exp(2)", "7.0")).toBeNull();
    expect(check("Evaluate $exp(2)$", numeric, "exp(2)", "exp(2.0)")).toBe("correct");
    expect(check(radical, numeric, sqrtTwo, "2.0")).toBe("incorrect");
    expect(check("Evaluate $sqrt(2)+sqrt(3)$", numeric, "sqrt(2)+sqrt(3)", "3.0")).toBe("incorrect");
  });

  it.each(["4.0.5", ".5.5", "1..2", "1.2.3"])("rejects malformed decimal tokens %s", token => {
    expect(check("Evaluate $sqrt(4)$", numeric, "2", token)).toBe("unparseable");
    expect(check("Evaluate $sqrt(4)$", numeric, token, "2")).toBeNull();
  });

  it.each(["Evaluate $ln(1) + exp(0)$", "Evaluate $cos(0) + sin(0)$"])(
    "checks exact logarithm, exponential and trigonometric constants in %s", stem => {
      expect(check(stem, numeric, "1", "1.0")).toBe("correct");
      expect(check(stem, numeric, "1", "1.5")).toBe("incorrect");
    },
  );

  it("supports a variable-free derivative result", () => {
    expect(check("Differentiate $2x+1$", numeric, "2", "2")).toBe("correct");
    expect(check("Differentiate $x^3$ at $x=2$", numeric, "12", "12")).toBe("correct");
    expect(check("Differentiate $x^3$ at $x=2$", numeric, "12", "3x^2")).toBe("unparseable");
  });

  it.each(["2", "单数 2", "计算 2", "求 x: x+1=2", "计算 1米+2米", "Calculate 1 cm+2 cm",
    "计算 $sqrt(2)$。写出答案。", "计算 $1/0$", "计算 $sqrt(4)+1/(2-2)$", "化简 $x-x$"])(
    "abstains for unsupported numeric stem %s", stem => {
      expect(check(stem, numeric, "2", "2")).toBeNull();
    },
  );

  it("requires a corroborated constant key and an interaction without units", () => {
    expect(check(radical, { ...numeric, unit: "" }, sqrtTwo, sqrtTwo)).toBeNull();
    expect(check(radical, numeric, "2", sqrtTwo)).toBeNull();
    expect(check(radical, numeric, "1/0", sqrtTwo)).toBeNull();
    expect(check(radical, numeric, " ".repeat(1200) + sqrtTwo, sqrtTwo)).toBeNull();
    expect(check(radical, numeric, sqrtTwo, " ".repeat(1200) + sqrtTwo)).toBe("unparseable");
  });
});

describe("symbolic Markdown boundaries", () => {
  it.each([
    [String.raw`1{0}+1`, "1"], ["{1+2}", "3"], ["{2}x+1", "2x+1"],
    [String.raw`2\frac{1}{2}`, "1"], [String.raw`2 \dfrac{1}{2}`, "1"], [String.raw`2\,\tfrac{1}{2}`, "1"],
    [String.raw`2\,000+1`, "2001"], [String.raw`4\,0.5+1`, "41.5"],
    ["2^2^3", "256"], ["2^{2}^3", "256"], ["2^2^{3}", "256"], ["2^−2", "1/4"], ["2^(2+1)", "8"],
    [String.raw`\left(2+1)`, "3"], [String.raw`(2+1\right)`, "3"], [String.raw`\left(2+1\right]`, "3"],
    [String.raw`\textstyle 2+1`, "3"],
  ])("abstains when TeX %s can be misread as %s", (expression, misleading) => {
    const interaction = choice(misleading, "0");
    expect(check(`Evaluate $${expression}$`, interaction, "A", "A. " + misleading)).toBeNull();
    expect(verifyStandaloneProofEquationClaim(`$${expression} = ${misleading}$`).status).toBe("unverified");
  });

  it.each([" ", "\\ ", "\\,", "\\;", "\\:", "\\!", "\\quad ", "\\qquad ", "~"])(
    "rejects spacing %j between digits or decimal points", space => {
      expect(check("Evaluate $sqrt(4)$", numeric, "2", `$4${space}0.5$`)).toBe("unparseable");
    },
  );

  it.each(["2^-2", "2^−2", "2^+2"])("rejects an ungrouped signed exponent without a math fence %s", expression => {
    expect(check("Evaluate $sqrt(4)$", numeric, "2", expression)).toBe("unparseable");
  });

  it.each([
    ["2^.0", "1"], ["2^2.", "4"], ["2^2.5", "4"],
    ["2^\\,3", "8"], ["2^~3", "8"], ["2^\\,{3}", "8"],
    ["2^~{3}", "8"], ["2^\u00a0{3}", "8"], ["2^(+2)", "4"],
    ["2^[2]", "4"], ["2^|2|", "4"], ["2^+2", "4"], ["2^12", "4096"], ["2^\\alpha", "2"],
  ])("rejects ambiguous TeX superscripts in %s", (expression, result) => {
    expect(check("Evaluate $" + expression + "$", numeric, result, result)).toBeNull();
    expect(verifyStandaloneProofEquationClaim("$" + expression + " = " + result + "$").status).toBe("unverified");
  });

  it.each([
    ["2^.0", "1"], ["2^0.0", "1"], ["2^0.5", "1"], ["2^.0^2", "1"],
    ["2^(+2)^3", "256"], ["2^(.0)^2", "1"], ["2^(1+1)^3", "256"], ["2^sqrt(4)^3", "256"],
    ...["\\,", "\\;", "\\!", "\\:", "\\ ", "~"].flatMap(space => [
      [`2^${space}2^3`, "256"], [`2^${space}0.0`, "1"],
    ]),
  ])("rejects ambiguous plain-text exponent notation in %s", (expression, result) => {
    expect(check("Evaluate " + expression, numeric, result, result)).toBeNull();
    expect(check("Evaluate $sqrt(4)$", numeric, "2", expression)).toBe("unparseable");
    expect(verifyStandaloneProofEquationClaim(expression + " = " + result).status).toBe("unverified");
  });

  it.each([
    ["$2^3$", "8"], ["$2^ {3}$", "8"], ["$2^{.0}$", "1"], ["$2^{2.0}$", "4"],
    ["2^(.0)", "1"], ["2^12", "4096"], ["(2^2)^3", "64"], ["2^(1+1)", "4"],
  ])("keeps supported exponent notation in %s", (expression, result) => {
    expect(check("Evaluate " + expression, numeric, result, result)).toBe("correct");
    expect(verifyStandaloneProofEquationClaim(expression + " = " + result).status).toBe("equivalent");
  });

  it("leaves a grouped noninteger exponent to the scalar engine", () => {
    expect(check("Evaluate $2^{0.5}$", numeric, "1", "1")).toBeNull();
    expect(check("Evaluate 2^(0.5)", numeric, "1", "1")).toBeNull();
  });

  it.each([
    ["\\sqrt\u00a0{4}", "2"], ["\\frac{1}\u00a0{2}", "0.5"],
    ["\\left\u2009[1+1\\right]", "2"], ["\\left[1+1\\right\u3000]", "2"],
    ["\\frac{d}{dx}\u00a0(3x)", "3"], ["\\frac{d}{d\u00a0x}(3x)", "3"],
  ])("abstains when non-ASCII whitespace occurs in a TeX command %j", (expression, result) => {
    expect(check(`Evaluate $${expression}$`, numeric, result, result)).toBeNull();
    expect(verifyStandaloneProofEquationClaim(`$${expression} = ${result}$`))
      .toEqual({ status: "unverified", unconditional: false });
  });

  it.each(["\\int\u00a02x\\,dx", "\\int 2x\u2009dx", "\\int 2x\\,d\u3000x"])(
    "abstains when non-ASCII whitespace occurs in an integral operator %j", integral => {
      expect(check(`Evaluate $${integral}$`, choice("x^2+C", "x^3+C"), "A", "A. x^2+C")).toBeNull();
      expect(verifyStandaloneProofEquationClaim(`$${integral} = x^2+C$`))
        .toEqual({ status: "unverified", unconditional: false });
    },
  );

  it.each([["(+2)", "4"], ["(-2)", "1/4"]])("requires TeX braces around the exponent %s", (exponent, result) => {
    const unbraced = "2^" + exponent;
    const braced = "$2^{" + exponent + "}$";
    expect(check("Evaluate $" + unbraced + "$", numeric, result, result)).toBeNull();
    expect(check("Evaluate " + braced, numeric, result, result)).toBe("correct");
    expect(check("Evaluate " + unbraced, numeric, result, result)).toBe("correct");
    expect(verifyStandaloneProofEquationClaim("$" + unbraced + " = " + result + "$"))
      .toEqual({ status: "unverified", unconditional: false });
    expect(verifyStandaloneProofEquationClaim(braced + " = " + result).status).toBe("equivalent");
  });

  it("does not interpret a TeX subscript as a scalar expression", () => {
    expect(check("Evaluate $2_(+2)$", numeric, "4", "4")).toBeNull();
    expect(verifyStandaloneProofEquationClaim("$2_(+2)=4$"))
      .toEqual({ status: "unverified", unconditional: false });
  });

  it.each([
    [String.raw`\left(2+\left[3\right]\right)`, "5"], [String.raw`\left\|2-3\right\|+1`, "2"],
    [String.raw`\frac{\sqrt{4}}{2^{2}}`, "1/2"], [String.raw`\dfrac{\sqrt{4}}{3}`, "2/3"],
    [String.raw`\tfrac{\sqrt{4}}{3}`, "2/3"], ["2^{-2}", "1/4"],
    [String.raw`\frac {\sqrt {4}} {2}`, "1"], [String.raw`\left [1+1\right ]`, "2"],
    ["(2^2)^3", "64"],
  ])("keeps supported grouping in %s", (expression, result) => {
    expect(check(`Evaluate $${expression}$`, numeric, result, result)).toBe("correct");
  });

  it("recognizes display math as one span", () => {
    expect(check("Simplify $$x*x$$", choice("$$x*x$$", "x+1"), "A", "A. $$x*x$$")).toBe("correct");
    expect(check("Simplify x\\*x", choice("x\\*x", "x+1"), "A", "A. x\\*x")).toBe("correct");
  });

  it("rejects ambiguous TeX arguments and accepts explicitly braced forms", () => {
    expect(check("Evaluate $\\sqrt12+1$", numeric, "sqrt(12)+1", "3")).toBeNull();
    expect(check("Evaluate $\\sqrt x+1$", choice("sqrt(x)+1", "sqrt(x)"), "A", "A. sqrt(x)+1")).toBeNull();
    expect(check("Simplify $\\frac123+x$", choice("x+4", "x"), "A", "A. x+4")).toBeNull();
    expect(check("Evaluate $sqrt(4)$", numeric, "2", "\\frac42")).toBe("unparseable");
    expect(check("Simplify $x^12+x$", choice("x^12+x", "x^12"), "A", "A. x^12+x")).toBeNull();
    expect(check("Differentiate $\\frac{d}{dx}(x^12)$", choice("12x^11", "x^12"), "A", "A. 12x^11")).toBeNull();
    expect(check("Evaluate $\\sqrt{4}+\\frac{2}{1}$", numeric, "4", "\\frac{8}{2}")).toBe("correct");
    expect(check("Simplify $x^{12}+x$", choice("x^12+x", "x^12"), "A", "A. x^12+x")).toBe("correct");
  });

  it.each(["$x$ * $x$", "x*x", "$x*x", "$x*\nx$", "$$x*\n\nx$$", "$$x*x$", "- $x^2$", "# $x^2$",
    "1. $x^2$", "---\n$x^2$", "- - -\n$x^2$"])("rejects ambiguous math markup %j", label => {
    expect(check("Simplify\n" + label, choice("x^2", "x+1"), "A", "A. x^2")).toBeNull();
    expect(check("Simplify $x*x$", choice("x^2", label), "A", "A. x^2")).toBeNull();
  });
});

function proof(claim: string, verdict: "correct" | "incorrect", required = true): ProofFeedback {
  return {
    coverage: "complete",
    steps: [{ stepIndex: 1, claim, verdict, required, feedback: "Check the step.", repairPrompt: "Recheck it." }],
  };
}

function adjudicate(outcome: "correct" | "incorrect", proofFeedback: ProofFeedback) {
  const proposal: AiGradingProposal = {
    outcome, proofFeedback, confidence: 1, questionMatch: true, feedback: "Check the proof.",
    criteria: [{ label: "Step", verdict: outcome, feedback: "Check the equality." }],
  };
  return acceptedAiGradingOutcome(proposal);
}

describe("symbolic proof feedback", () => {
  it.each(["2=3", "2=2x=3", "2x=2x+1", "2x+1=2x+2"])(
    "vetoes an impossible derivative equality chain %s", chain => {
      const claim = "$\\frac{d}{dx}(x^2)=" + chain + "$";
      expect(verifyStandaloneProofEquationClaim(claim)).toEqual({ status: "inequivalent", unconditional: false });
      expect(adjudicate("correct", proof(claim, "correct"))).toBe("unverified");
    },
  );

  it("distinguishes derivative chains that agree everywhere or only at a point", () => {
    const derivative = "\\frac{d}{dx}(x^2)";
    expect(verifyStandaloneProofEquationClaim("$" + derivative + "=2x=x+x$"))
      .toEqual({ status: "equivalent", unconditional: true });
    expect(verifyStandaloneProofEquationClaim("$" + derivative + "=2=x+1$"))
      .toEqual({ status: "unverified", unconditional: false });
  });

  it.each([
    ["Assume x+1=x.", "Suppose the opposite."],
    ["x+1=x", "Assume this equality for contradiction."],
  ])("preserves an explicit proof by contradiction beginning with %s", (claim, comment) => {
    const feedback = proof(claim, "correct");
    const first = { ...feedback.steps[0]!, feedback: comment };
    feedback.steps = [first, { ...first, stepIndex: 2, claim: "1=0", feedback: "Subtract x." },
      { ...first, stepIndex: 3, claim: "Reject the assumption.", feedback: "No such x exists." }];
    expect(proofFeedbackAllowsOutcome("correct", feedback)).toBe(true);
    expect(adjudicate("correct", feedback)).toBe("correct");
  });

  it.each(["Assume the equation for contradiction.", "This is the derived contradiction."])(
    "preserves a step whose feedback identifies its role in a contradiction proof: %s", comment => {
      const feedback = proof("1=0", "correct");
      feedback.steps[0]!.feedback = comment;
      expect(adjudicate("correct", feedback)).toBe("correct");
    },
  );

  it("still vetoes a false direct calculation after an assumption without a rejection", () => {
    const feedback = proof("Assume x = 2.", "correct");
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, claim: "1=0" });
    expect(proofFeedbackAllowsOutcome("correct", feedback)).toBe(false);
    expect(adjudicate("correct", feedback)).toBe("unverified");
  });

  it("requires a supposition before the refuted step", () => {
    const feedback = proof("1=0", "correct");
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, claim: "Assume x=2 for contradiction." },
      { ...feedback.steps[0]!, stepIndex: 3, claim: "Reject the assumption." });
    expect(adjudicate("correct", feedback)).toBe("unverified");
  });

  it("does not mistake a reference to an assumption for introducing one", () => {
    const feedback = proof("1=0", "correct");
    feedback.steps[0]!.feedback = "Reject the assumption.";
    expect(adjudicate("correct", feedback)).toBe("unverified");
  });

  it.each(["Work in the field F₂", "\\mathbb{F}_{2}", "GF(2)", "\\mathbb{Z}/2\\mathbb{Z}",
    "modulo 2", "\\pmod{2}", "char 2", "boolean algebra", "有限域", "模 2", "matrix algebra", "linear operators"])(
    "does not apply real-scalar verification in context %s", context => {
      const feedback = proof(context, "correct", false);
      feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, required: true, claim: "1+1=0" });
      expect(adjudicate("correct", feedback)).toBe("correct");
    },
  );

  it("retains a negative proof verdict when feedback establishes modular arithmetic", () => {
    const claim = "sqrt(4) = 2";
    expect(verifyStandaloneProofEquationClaim(claim)).toEqual({ status: "equivalent", unconditional: true });
    const feedback = proof(claim, "incorrect");
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, required: false, claim: "Check the choice of root.",
      feedback: "No principal square root was specified in F₅." });
    expect(proofFeedbackAllowsOutcome("incorrect", feedback)).toBe(true);
    expect(adjudicate("incorrect", feedback)).toBe("incorrect");
  });

  it.each([
    "x^2 + C = x^2 + C + 1",
    "x^2 + C + 1 = x^2 + x + C = x^2 + C",
    "x^2 + C = (x+1)^2 - 2x + C",
    "x^2 + C = x^2 + 2C = x^2 + 2C + 1",
    "x^2 + C + 1/x = x^2 + C + 1/x + 1",
  ])("vetoes a constant contradiction between integral candidates %s", chain => {
    const claim = "\\int 2x\\,dx = " + chain;
    expect(verifyStandaloneProofEquationClaim(claim)).toEqual({ status: "inequivalent", unconditional: false });
    expect(adjudicate("correct", proof(claim, "correct"))).toBe("unverified");
  });

  it.each(["x^2 + C = x^2 + 2C", "x^2 + C = x^2 + x + C"])(
    "abstains when an integral equality chain could agree under an assumption %s", chain => {
      const claim = "\\int 2x\\,dx = " + chain;
      expect(verifyStandaloneProofEquationClaim(claim)).toEqual({ status: "unverified", unconditional: false });
      expect(adjudicate("correct", proof(claim, "correct"))).toBe("correct");
    },
  );

  it("corroborates an integral equality chain whose candidates agree for the same C", () => {
    const claim = "\\int 2x\\,dx = (x+1)^2 + C - 2x - 1 = x^2 + C";
    expect(verifyStandaloneProofEquationClaim(claim)).toEqual({ status: "equivalent", unconditional: true });
    expect(adjudicate("incorrect", proof(claim, "incorrect"))).toBe("unverified");
  });

  it.each([
    "x + 1 = x + 2", "(x+1)^2 = x^2 + 2x + 2", "Step 1: $$(x+1)^2 = x^2 + 2x + 1 = x^2 + 2x + 2$$",
    "1/x + 1 = 1/x + 2", "x^2 = x + 1 = x + 2", String.raw`x + \sqrt{2} = x`,
    String.raw`\sin(x)^2 + \cos(x)^2 = 2`, "1/2 + 1/3 = 2/5", String.raw`\sqrt{4} = 3`,
    String.raw`Step 1: $\frac{d}{dx}(x^2) = 2x + 1$`, String.raw`$\frac{d}{dx}(3x) = 2$`,
    String.raw`1. \int 2x\,dx = x^3 + C`,
  ])("vetoes a positive verdict on a refuted required claim %s", claim => {
    expect(verifyStandaloneProofEquationClaim(claim)).toEqual({ status: "inequivalent", unconditional: false });
    expect(proofFeedbackAllowsOutcome("correct", proof(claim, "correct"))).toBe(false);
    expect(adjudicate("correct", proof(claim, "correct"))).toBe("unverified");
  });

  it("preserves a correct proof with an equation under an earlier assumption", () => {
    const feedback = proof("Assume x = 2.", "correct");
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, claim: "$x + 1 = 3$" });
    expect(adjudicate("correct", feedback)).toBe("correct");
  });

  it("preserves a correct proof that evaluates the derivative at an earlier point", () => {
    const feedback = proof("Evaluate the derivative at x = 1.", "correct");
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, claim: String.raw`$\frac{d}{dx}(x^2)=2$` });
    expect(adjudicate("correct", feedback)).toBe("correct");
  });

  it.each([
    "x + 1 = 3", "(x+1)^2 = x^2 + 1", "x/x = 1", "sqrt(x)^2 = x",
    String.raw`e^{\ln(x)} = x`, String.raw`\frac{d}{dx}(\ln(x)) = 1/x`,
    String.raw`\frac{d}{dx}(x^2) = 2\sqrt{x^2}`, String.raw`\int 2x\,dx = x\sqrt{x^2} + C`,
    String.raw`\frac{d}{dx}(x^2) = 2\sqrt{(x-1)^2} + 2`,
    String.raw`Step 1: $\frac{d}{dx}(x^3) = x^2$`, String.raw`\frac{d}{dx}(x^2) = 2`,
    String.raw`\int 2x\,dx = \sqrt{x^4} + C`,
    String.raw`\int 2x\,dx = (1+\sqrt{x})^0 + C`,
  ])("abstains when the proof context could affect the claim %s", claim => {
    expect(verifyStandaloneProofEquationClaim(claim)).toEqual({ status: "unverified", unconditional: false });
    expect(adjudicate("correct", proof(claim, "correct"))).toBe("correct");
  });

  it.each([
    ["(2)+3=5", "equivalent"],
    ["(2)+3=3", "inequivalent"],
    ["(2) x = 2x", "equivalent"],
    ["1. +3=3", "unverified"],
    ["第 2 步： $1$ = $2$", "inequivalent"],
  ])("keeps mathematical operands when checking %s", (claim, status) => {
    expect(verifyStandaloneProofEquationClaim(claim).status).toBe(status);
  });

  it.each([
    ["$1$ = $2$", "inequivalent"],
    ["$$x+x$$ = $2x$", "equivalent"],
    ["$x+x=2x$ = $2x$", "unverified"],
    ["$1$ != $2$", "unverified"],
    ["$1$ <= $2$", "unverified"],
    ["$1$ = $2", "unverified"],
    ["$x^12 = x^{12}$", "unverified"],
  ])("checks equality boundaries in %s", (claim, status) => {
    expect(verifyStandaloneProofEquationClaim(claim).status).toBe(status);
    if (status === "inequivalent") expect(adjudicate("correct", proof(claim, "correct"))).toBe("unverified");
    if (status === "equivalent") expect(adjudicate("incorrect", proof(claim, "incorrect"))).toBe("unverified");
  });

  it.each([
    "(x+1)^2 = x^2 + 2x + 1",
    String.raw`\frac{d}{dx}(x^3) = 3x^2`,
    String.raw`\int 2x\,dx = x^2 + C`,
  ])("vetoes a negative verdict justified only by an unconditional identity %s", claim => {
    expect(proofFeedbackAllowsOutcome("incorrect", proof(claim, "incorrect"))).toBe(false);
    expect(adjudicate("incorrect", proof(claim, "incorrect"))).toBe("unverified");
  });

  it.each(["x/x = 1", "1/(x^2+1) = 1/(1+x^2)", "sqrt(x)^2 = x", "假设 x=1，得 0=1，矛盾",
    "设 Av=λv", "两边同乘非零常数", "If x=1 then x^2=1", "x!=1", "(x+1)^2=x^2+1"])(
    "retains a negative verdict when %s is not an unconditional verified identity", claim => {
      expect(proofFeedbackAllowsOutcome("incorrect", proof(claim, "incorrect"))).toBe(true);
      expect(adjudicate("incorrect", proof(claim, "incorrect"))).toBe("incorrect");
    },
  );

  it.each(["假设 x=1，得 0=1，矛盾", "If x=1 then x^2=1", "设 Av=λv", "1=0 if x>1", "x!=1"])(
    "does not veto a proof verdict on prose or assumptions %s", claim => {
      expect(proofFeedbackAllowsOutcome("correct", proof(claim, "correct"))).toBe(true);
    },
  );

  it("abstains when a derivative operator has an ambiguous scope", () => {
    const claim = "\\frac{d}{dx}(x^2) + 1 = 2x + 1";
    expect(verifyStandaloneProofEquationClaim(claim).status).toBe("unverified");
    expect(proofFeedbackAllowsOutcome("correct", proof(claim, "correct"))).toBe(true);
  });

  it("only uses required steps and abstains from proving beyond engine limits", () => {
    const feedback = proof("(x+1)^2 = x^2 + 2x + 1", "correct");
    feedback.steps.push({ ...proof("x + 1 = x + 2", "correct", false).steps[0]!, stepIndex: 2 });
    expect(adjudicate("correct", feedback)).toBe("correct");
    const claim = "(x+1)^1000 = (x+1)^1000";
    expect(verifyStandaloneProofEquationClaim(claim).status).toBe("unverified");
    expect(adjudicate("incorrect", proof(claim, "incorrect"))).toBe("incorrect");
    expect(check("Simplify $(x+1)^1000$", choice("(x+1)^1000", "1"), "A", "A. (x+1)^1000")).toBeNull();
  });
});

describe("structured symbolic steps", () => {
  it.each(["(1+\\sqrt{-x^2})^0", "(1+\\sqrt{x^2(x-1)})^0"])(
    "abstains when an integrand's domain includes isolated or non-interior points: %s", reference => {
      const particular = "x*" + reference;
      const student = particular + " + C";
      const claim = "\\int " + reference + "\\,dx";
      expect(verifySymbolicStepEquivalence({ kind: "indefinite-integral", reference, student })).toBe("unverified");
      expect(check("Evaluate the indefinite integral " + claim, choice("$" + student + "$", "$" + particular + "$"),
        "A", "A. $" + student + "$")).toBeNull();
      expect(verifyStandaloneProofEquationClaim("$" + claim + " = " + student + "$").status).toBe("unverified");
    },
  );

  it("abstains when a candidate antiderivative has a radicand boundary erased by differentiation", () => {
    const input = { kind: "indefinite-integral" as const, reference: "2x" };
    expect(verifySymbolicStepEquivalence({ ...input, student: "x^2+(1+sqrt(x^2))^0+C" })).toBe("unverified");
    expect(verifySymbolicStepEquivalence({ ...input, student: "x^2+(1+sqrt(x^2+1))^0+C" })).toBe("equivalent");
    expect(verifySymbolicStepEquivalence({ ...input, student: "x^3/x+C" })).toBe("inequivalent");
  });

  it("abstains when the integration variable is C", () => {
    const integral = String.raw`\int 2C\,dC`;
    expect(check(`Evaluate $${integral}$`, choice("C^2", "C^3"), "A", "A. C^2")).toBeNull();
    expect(verifyStandaloneProofEquationClaim(`${integral} = C^2`)).toEqual({ status: "unverified", unconditional: false });
    expect(verifySymbolicStepEquivalence({ kind: "indefinite-integral", reference: "2C", student: "C^2", variable: "C" }))
      .toBe("unverified");
  });

  it.each([String.raw`(1+\sqrt{-x^2})^0`, "sqrt(-x^2)", "(1+sqrt(-x^2-1))^0"])(
    "abstains on derivatives without an open source domain %s", source => {
      expect(check(`Differentiate $${source}$ at $x=0$`, numeric, "0", "0")).toBeNull();
      expect(verifySymbolicStepEquivalence({ kind: "derivative", reference: source, student: "0" })).toBe("unverified");
    },
  );

  it("verifies a derivative at a strictly interior point with an irrational source value", () => {
    expect(check("Differentiate $(1+sqrt(x))^0$ at $x=2$", numeric, "0", "0")).toBe("correct");
    expect(check("Differentiate $(1+sqrt(x))^0$ at $x=0$", numeric, "0", "0")).toBeNull();
  });

  it("abstains when the source has an isolated point or includes a boundary point", () => {
    const reference = "(1+sqrt(x^2(x-1)))^0";
    const candidate = "0*sqrt(x^2(x-1))";
    const stem = "Differentiate $" + reference + "$";
    const correctLabel = "$" + candidate + "$";
    const wrongLabel = "$1+" + candidate + "$";
    const interaction = choice(correctLabel, wrongLabel);
    expect(check(stem, interaction, "A", "A. " + correctLabel)).toBeNull();
    expect(check(stem, interaction, "A", "B. " + wrongLabel)).toBeNull();
    expect(check("Differentiate " + reference, interaction, "A", "A. " + correctLabel)).toBeNull();
    expect(check(stem + " for $x != 0$", interaction, "A", "A. " + correctLabel)).toBeNull();
    expect(verifySymbolicStepEquivalence({ kind: "derivative", reference, student: candidate })).toBe("unverified");
    expect(verifyStandaloneProofEquationClaim("$\\frac{d}{dx}(" + reference + ") = " + candidate + "$"))
      .toEqual({ status: "unverified", unconditional: false });
    for (const point of [0, 1]) expect(check(stem + " at $x=" + point + "$", numeric, "0", "0")).toBeNull();
    expect(check(stem + " at $x=2$", numeric, "0", "0")).toBe("correct");
    expect(check(stem + " at $x=2$", choice("0", "1"), "A", "A. 0")).toBe("correct");
  });

  it.each([
    ["sqrt(x^2+1)", "x/sqrt(x^2+1)"],
    ["1/sqrt(x)", "-1/(2*x*sqrt(x))"],
  ])("checks derivatives on the open natural domain of %s", (reference, student) => {
    expect(verifySymbolicStepEquivalence({ kind: "derivative", reference, student })).toBe("equivalent");
  });

  it("finds rational interior witnesses away from the origin", () => {
    const reference = "(1+sqrt(x-10)/(x-10))^0";
    expect(verifySymbolicStepEquivalence({ kind: "derivative", reference, student: `0*${reference}` })).toBe("equivalent");
  });

  it("uses the declared variable and distinguishes invalid from inequivalent steps", () => {
    const derivative = { kind: "derivative" as const, reference: "t^3", variable: "t" };
    expect(verifySymbolicStepEquivalence({ ...derivative, student: "3t^2" })).toBe("equivalent");
    expect(verifySymbolicStepEquivalence({ ...derivative, student: "t^2" })).toBe("inequivalent");
    expect(verifySymbolicStepEquivalence({ ...derivative, student: "1/0" })).toBe("unverified");
  });
});
