import type { AiEvaluation, AiGradingProposal, ProofFeedback } from "@aistudy/contracts";
import { describe, expect, it } from "vitest";
import { acceptedAiGradingOutcome, evaluateAiCorrectness } from "./ai-evaluation";
import { observation } from "./evidence-eligibility-fixtures";
import type { EvidenceEligibilityReasonCode } from "./evidence-eligibility-types";
import { proofFeedbackAllowsOutcome } from "./proof-feedback";
import { independentProseClauses, proofStepUsesRealScalar, verifyStandaloneProofEquationClaim, verifySymbolicStepEquivalence } from "./symbolic-answer-bridge";
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
    ["sqrt(4)/6", "1/3", "1.0/3", "correct"],
    ["sqrt(4)/6", "1/3", "2/6.0", "correct"],
    ["sqrt(4)/6", "1/3", "0.333", "unparseable"],
    ["sqrt(4)/4", "1/2", "0.4", "incorrect"],
    ["sqrt(4)/6", "1/3", "1.0/3 + 0/(2-2)", "unparseable"],
  ])("uses exact equivalence before the decimal approximation rule for %s, key %s, answer %s", (stem, key, answer, expected) => {
    expect(check(`Evaluate $${stem}$`, numeric, key, answer)).toBe(expected);
  });

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

type ProposalContext = Partial<Pick<AiGradingProposal, "feedback" | "criteria" | "transcription">>;

function gradingProposal(outcome: "correct" | "incorrect", proofFeedback: ProofFeedback, context?: ProposalContext): AiGradingProposal {
  return {
    outcome, proofFeedback, confidence: 1, questionMatch: true, feedback: "Check the proof.",
    criteria: [{ label: "Step", verdict: outcome, feedback: "Check the equality." }],
    ...context,
  };
}

function adjudicate(outcome: "correct" | "incorrect", proofFeedback: ProofFeedback, context?: ProposalContext) {
  return acceptedAiGradingOutcome(gradingProposal(outcome, proofFeedback, context));
}

function incorrectEquality(claim: string, feedback = "The equality is incorrect."): ProofFeedback {
  const result = proof(claim, "incorrect");
  result.steps[0]!.feedback = feedback;
  return result;
}

function sequence(...claims: string[]): ProofFeedback {
  const result = proof(claims[0]!, "correct");
  const first = result.steps[0]!;
  result.steps.push(...claims.slice(1).map((claim, index) => ({ ...first, stepIndex: index + 2, claim })));
  return result;
}

function expectOutcome(
  outcome: "correct" | "incorrect", feedback: ProofFeedback, expected: typeof outcome | "unverified",
  context?: ProposalContext,
) {
  const proposal = gradingProposal(outcome, feedback, context);
  const observed = { ...observation, observationId: "observation-1", outcome };
  const evaluation: AiEvaluation = {
    ...proposal, observationId: observed.observationId, attemptId: observed.attemptId!,
    problemId: observed.problemId!, itemVersionId: observed.itemVersionId!,
    requirementKey: observed.requirementKey!, evaluatorVersion: "ai-rubric-v1", modelLabel: null,
    evaluatedAt: "2026-10-21T08:00:00Z",
  };
  const reasons = new Set<EvidenceEligibilityReasonCode>();
  expect(evaluateAiCorrectness(observed, evaluation, reasons)).toBe("unknown");
  expect({
    allowed: proofFeedbackAllowsOutcome(outcome, feedback, proposal),
    accepted: acceptedAiGradingOutcome(proposal),
    reasons: [...reasons],
  }).toEqual(expected === "unverified"
    ? { allowed: false, accepted: expected, reasons: ["ai_evaluation_criteria_inconsistent"] }
    : { allowed: true, accepted: expected, reasons: [
      expected === "correct" ? "ai_graded_correct" : "ai_graded_incorrect", "ai_evaluation_uncalibrated",
    ] });
}

describe("symbolic proof feedback Round 19", () => {
  const identity = "(x+1)^2=x^2+2x+1";

  it.each(["Step 2", "Step 2.", "Step 2:", "Step 2. Algebra", "The second step", "第二步"])(
    "keeps the domain feedback under criterion label %s", label => {
      const criteria: AiGradingProposal["criteria"] = [{ label, verdict: "correct", feedback: "Work over F₂." }];
      expectOutcome("correct", sequence("1+1=2", "1+1=0"), "correct", { criteria });
      expectOutcome("correct", sequence("1+1=0", "1+1=2"), "unverified", { criteria });
    },
  );

  it("uses a temporary criterion scope until feedback specifies another step", () => {
    const steps = sequence("1+1=2", "1+1=0", "2+2=4");
    const label = "Step 2 only:";
    const criteria = (feedback: string): AiGradingProposal["criteria"] => [{ label, verdict: "correct", feedback }];
    expectOutcome("correct", steps, "correct", {
      criteria: criteria("Work over F₂."),
    });
    expectOutcome("correct", sequence("1+1=2", "1+1=0", "1+1=0"), "unverified", {
      criteria: criteria("Work over F₂."),
    });
    expectOutcome("correct", steps, "unverified", {
      criteria: criteria("In Step 3, work over F₂."),
    });
    expectOutcome("correct", steps, "correct", {
      criteria: criteria("Work over F₂, then switch permanently to ℝ."),
    });
  });

  it("keeps a criterion's asserted feedback when its label describes a rubric example", () => {
    expectOutcome("correct", sequence("1+1=0"), "unverified", {
      feedback: "Work over F₂.",
      criteria: [{ label: "Work over F₂ as an example", verdict: "correct", feedback: "Work over ℝ." }],
    });
  });

  it.each([
    "Only in the next step, use F₂.", "Solely for the final step, use F₂.",
    "Only at the 2nd step, use F₂.", "Just in the second step, use F₂.",
    "仅在下一步，使用 F₂。", "只在最后一步，使用 F₂。",
  ])("binds a temporary domain after a determiner in %s", feedback => {
    const final = /final|最后/u.test(feedback);
    const steps = final ? sequence("1+1=2", "2+2=4", "1+1=0") : sequence("1+1=2", "1+1=0", "2+2=4");
    steps.steps[0]!.feedback = feedback;
    const transcription = "Work over ℝ. " + steps.steps.map(step => step.claim).join(". ") + ".";
    const expected = final ? [true, true, false] : [true, false, true];
    expect([...proofStepUsesRealScalar(steps.steps, transcription, []).values()]).toEqual(expected);
    expectOutcome("correct", steps, "correct", { transcription });
  });

  it.each([
    "For this step only, use F₂, then switch permanently to ℝ.",
    "Only in this step use F₂; afterwards work over ℝ.",
    "For this step only, use F₂, and thereafter work over ℝ.",
    "Use F₂ for this step only; work over ℝ from now on.",
    "仅在本步使用 F₂，随后永久改用 ℝ。",
  ])("makes persistence a property of each domain clause in %s", transition => {
    const steps = sequence("1+1=0", "1+1=0", "1+1=0");
    steps.steps[0]!.feedback = transition;
    const transcription = "Work over F₂. 1+1=0. 1+1=0. 1+1=0.";
    expectOutcome("correct", steps, "unverified", { transcription });
    expect([...proofStepUsesRealScalar(steps.steps, transcription, []).values()]).toEqual([false, true, true]);
    const transcribed = "Work over F₂. " + transition + " 1+1=0. 1+1=0. 1+1=0.";
    const transcribedSteps = sequence("1+1=0", "1+1=0", "1+1=0");
    expectOutcome("correct", transcribedSteps, "unverified", { transcription: transcribed });
    expect([...proofStepUsesRealScalar(transcribedSteps.steps, transcribed, []).values()]).toEqual([false, true, true]);
  });

  it.each([
    ["After the final step, use F₂.", true], ["Following the last step, use F₂.", true],
    ["After the next step, use F₂.", true], ["最后一步之后使用 F₂。", true],
    ["第二步之后使用 F₂。", true], ["After the penultimate step, use F₂.", false],
    ["After the first step, use F₂.", false], ["第一步完成后使用 F₂。", false],
  ] as const)("resolves %s relative to the referenced position", (feedback, finalIsReal) => {
    const steps = sequence("1+1=2", "1+1=0");
    expectOutcome("correct", steps, finalIsReal ? "unverified" : "correct", { feedback });
    expect([...proofStepUsesRealScalar(steps.steps, undefined, [feedback]).values()]).toEqual([true, finalIsReal]);
  });

  it.each([
    "Until this is done, stay in ℝ.", "Until this step is finished, work over ℝ.",
    "Stay in ℝ until this step ends.", "Until the end of this step, use ℝ.",
    "在本步结束前，使用 ℝ。", "保持在 ℝ 中，直到本步完成。",
  ])("applies %s locally and restores the prior domain", feedback => {
    const steps = sequence("1+1=0", "1+1=0");
    steps.steps[0]!.feedback = feedback;
    const transcription = "Work over F₂. 1+1=0. 1+1=0.";
    expectOutcome("correct", steps, "unverified", { transcription });
    expect([...proofStepUsesRealScalar(steps.steps, transcription, []).values()]).toEqual([true, false]);
  });

  it.each([
    "Now work over ℝ, using addition as an example.",
    "Now work over ℝ (taking addition as an example).",
    "Now work over ℝ, for example by adding.",
    "现在在 ℝ 中计算（以加法为例）。", "现在在 ℝ 中计算，以加法作为例子。",
  ])("retains the domain before the illustrative aside in %s", feedback => {
    const steps = sequence("1+1=0", "Continue.");
    steps.steps[0]!.feedback = feedback;
    expectOutcome("correct", steps, "unverified", { transcription: "Work over F₂. 1+1=0." });
  });

  it.each(["`", "``", "```"])("masks rubric prose quoted with %s while locating transcribed equations", mark => {
    const feedback = "The rubric gives " + mark + "work over F₂" + mark + " as feedback.";
    expectOutcome("correct", sequence("1+1=0"), "unverified", {
      transcription: "Work over ℝ. 1+1=0.", feedback,
    });
    const transcription = "Work over ℝ. " + mark + "1+1=0" + mark + ". Work over F₂. 1+1=0.";
    const steps = sequence("1+1=0", "1+1=0");
    expectOutcome("correct", steps, "unverified", { transcription });
    expect([...proofStepUsesRealScalar(steps.steps, transcription, []).values()]).toEqual([true, false]);
  });

  it.each([
    "The other step", "Other steps", "Another step", "The remaining steps", "Subsequent steps", "Later steps",
    "Previous steps", "Prior steps", "Earlier steps", "Preceding steps", "其他步骤", "其余步骤", "后续步骤", "后面的步骤",
  ])("does not apply critique of %s to the current step", label => {
    expectOutcome("incorrect", incorrectEquality(identity), "unverified", {
      feedback: label + " skips a necessary step.",
    });
    expectOutcome("incorrect", incorrectEquality(identity), "unverified", {
      criteria: [{ label, verdict: "incorrect", feedback: "Skips a necessary step." }],
    });
  });

  it.each([
    "Step 1 skips another step.", "Step 1 omits the other step.", "Step 1 is missing the next step.",
    "Step 1 omits an intermediate step.", "Step 1 skips a necessary step.", "The proof lacks a step.",
    "Each step skips a necessary step.", "Every step skips a necessary step.",
    "All steps lack justification.", "Both steps lack justification.",
  ])("retains a current-step inference critique in %s", feedback => {
    expectOutcome("incorrect", incorrectEquality(identity), "incorrect", { feedback });
  });

  it.each([
    "four derivations", "nineteen steps", "twenty-one steps", "two intermediate derivations",
    "several earlier claims", "all three equations", "fourteen thousand lines", "critical intermediate derivations",
    "first two steps", "unjustified algebraic calculations",
  ])("keeps %s inside a coordinated denial", subject => {
    const feedback = "It is false that the proof lacks justification, and that " + subject + " skip a necessary step.";
    expectOutcome("incorrect", incorrectEquality(identity, feedback), "unverified", {
      feedback: "The equality is incorrect.",
    });
    expect(independentProseClauses(feedback)).toEqual([feedback]);
  });
});

describe("symbolic proof feedback Round 18", () => {
  const real = { transcription: "Work over ℝ. 1+1=0." };
  const identity = "(x+1)^2=x^2+2x+1";

  it.each([
    'The rubric gives "work over F₂" as feedback.',
    "The rubric gives “work over F₂” as an example of feedback.",
    "The rubric says 'work over F₂'.", "The rubric says ‘work over F₂’.",
    "评分细则写着「在 F₂ 上计算」。", "评分细则写着『在 F₂ 上计算』。",
    "The rubric uses work over F₂ as an example.",
    "The rubric illustrates its wording, for example, work over F₂.",
    "The rubric illustrates its wording, e.g. work over F₂.",
    "评分细则将在 F₂ 上计算作为反馈示例。", "评分细则举例说明：在 F₂ 上计算。",
  ])("ignores illustrative scalar domains in %s", feedback => {
    const steps = sequence("1+1=0");
    steps.steps[0]!.feedback = feedback;
    expectOutcome("correct", steps, "unverified", real);
    expectOutcome("correct", sequence("1+1=0"), "unverified", {
      feedback, transcription: "Work over ℝ. " + feedback + " 1+1=0.",
    });
  });

  it.each([
    "Work over $F₂$.", "For example, over $F₂$, 1+1=0.", "例如在 $F₂$ 上有 1+1=0。",
  ])("preserves mathematical domain evidence in %s", transcription => {
    expectOutcome("correct", sequence("1+1=0"), "correct", { transcription });
  });

  it("keeps asserted evidence before an illustrative aside", () => {
    const steps = sequence("1+1=0");
    steps.steps[0]!.feedback = "Work over ℝ, for example the rubric mentions F₂.";
    expectOutcome("correct", steps, "unverified", { transcription: "Work over F₂. 1+1=0." });
  });

  it.each([
    "Use F₂ starting in the next step.", "Use F₂, starting in the next step.",
    "Use F₂, in the next step.", "Work over F₂, from Step 2 onward.",
    "在 F₂ 上计算，从下一步开始。", "在 F₂ 上计算，仅在下一步。",
  ])("attaches a trailing step qualifier in %s", feedback => {
    const steps = sequence("1+1=0", "Continue.");
    steps.steps[0]!.feedback = feedback;
    expectOutcome("correct", steps, "unverified", real);
    expect([...proofStepUsesRealScalar(steps.steps, real.transcription, []).values()]).toEqual([true, false]);
  });

  it.each([
    "Use ℝ, and in the next step use F₂", "In Step 1 use ℝ, in Step 2 use F₂",
    "第一步使用 ℝ，第二步使用 F₂",
  ])("keeps independent domain clauses in %s", feedback => {
    const steps = sequence("1+1=2", "1+1=0");
    steps.steps[0]!.feedback = feedback;
    expectOutcome("correct", steps, "correct");
    expect([...proofStepUsesRealScalar(steps.steps, undefined, []).values()]).toEqual([true, false]);
  });

  it.each([
    "The next step uses ℝ, but for this step use F₂.",
    "In Step 2 use ℝ, and in this step use F₂.",
    "Step 2 uses ℝ, while this step uses F₂.",
    "The next step uses ℝ, but throughout this particular step use F₂.",
    "下一步使用 ℝ，但在本步中使用 F₂。", "下一步使用 ℝ，此行使用 F₂。",
  ])("returns to the current step in %s", feedback => {
    const steps = sequence("1+1=0", "1+1=2");
    steps.steps[0]!.feedback = feedback;
    expectOutcome("correct", steps, "correct", real);
    expect([...proofStepUsesRealScalar(steps.steps, real.transcription, []).values()]).toEqual([false, true]);
  });

  it.each([
    "For this step only, work over F₂.", "Work over F₂ for this step only.",
    "Only in this step, use F₂.", "In Step 1 only, work over F₂.",
    "In this single step, work over F₂.", "Temporarily work over F₂ for this step.",
    "Use F₂ in this step alone.", "Use F₂ solely for this step.", "Use F₂ exclusively in this step.",
    "Just for this step use F₂.", "Merely for this step use F₂.",
    "仅在本步中使用 F₂。", "只在第一步使用 F₂。", "本步暂时使用 F₂。",
  ])("keeps an override local to the named step in %s", feedback => {
    const steps = sequence("2+2=4", "1+1=0");
    steps.steps[0]!.feedback = feedback;
    const transcription = "Work over ℝ. 2+2=4. 1+1=0.";
    expectOutcome("correct", steps, "unverified", { transcription });
    expect([...proofStepUsesRealScalar(steps.steps, transcription, []).values()]).toEqual([false, true]);
  });

  it("applies temporary overrides from anchored and transcribed clauses", () => {
    const steps = sequence("2+2=4", "1+1=0", "1+1=2");
    const feedback = "Only in Step 2, use F₂.";
    const transcription = "Work over ℝ. 2+2=4. 1+1=0. 1+1=2.";
    expectOutcome("correct", steps, "correct", { feedback, transcription });
    expect([...proofStepUsesRealScalar(steps.steps, transcription, [feedback]).values()]).toEqual([true, false, true]);
    const inline = "Work over ℝ. 2+2=4, work over F₂ for this step only. 1+1=0. 1+1=2.";
    expectOutcome("correct", steps, "unverified", { transcription: inline });
    expect([...proofStepUsesRealScalar(steps.steps, inline, []).values()]).toEqual([false, true, true]);
  });

  it("keeps a temporary override for a missing step label from leaking to a later step", () => {
    const steps = sequence("2+2=4", "1+1=0");
    steps.steps[1]!.stepIndex = 4;
    const transcription = "Work over ℝ. 2+2=4. 1+1=0.";
    expectOutcome("correct", steps, "unverified", { transcription, feedback: "Only in Step 2, use F₂." });
    expectOutcome("correct", steps, "correct", { transcription, feedback: "From Step 2 onward, use F₂." });
  });

  it.each([
    "After this, use F₂.", "Following this, use F₂.", "Beyond this, work over F₂.",
    "Once this is done, use F₂.", "在此之后，使用 F₂。", "这之后使用 F₂。",
  ])("defers a nounless transition in %s", feedback => {
    const steps = sequence("1+1=0", "Continue.");
    steps.steps[0]!.feedback = feedback;
    expectOutcome("correct", steps, "unverified", real);
    expect([...proofStepUsesRealScalar(steps.steps, real.transcription, []).values()]).toEqual([true, false]);
  });

  it.each(["After this field, use F₂.", "After this ring, use F₂.", "After this second step, use F₂."])(
    "keeps nounless transition matching distinct from other uses of this in %s", feedback => {
      const steps = sequence("2+2=4", "Continue.", "Finish.");
      steps.steps[0]!.feedback = feedback;
      const expected = feedback.includes("second") ? [true, true, false] : [false, false, false];
      expect([...proofStepUsesRealScalar(steps.steps, undefined, []).values()]).toEqual(expected);
    },
  );

  it.each([
    "both derivations skip", "neither derivation skips", "either step skips", "another proof skips",
    "other proofs skip", "many lines skip", "several equations skip", "few arguments skip",
    "most calculations skip", "one derivation skips", "two derivations skip", "three derivations skip",
    "12 derivations skip", "first steps skip", "second steps skip", "third steps skip", "next steps skip",
    "later steps skip", "earlier steps skip", "previous steps skip", "subsequent steps skip",
    "final steps skip", "last steps skip", "remaining steps skip", "following steps skip",
    "derivations skip", "equalities skip", "Step 1 skips",
  ])("keeps the coordinated complement under its denial in %s", subject => {
    const feedback = "It is false that the proof lacks justification, and that " + subject + " a necessary step.";
    expectOutcome("incorrect", incorrectEquality(identity, feedback), "unverified", { feedback: "The equality is incorrect." });
    expect(independentProseClauses(feedback)).toEqual([feedback]);
  });

  it.each([
    "It is false that the proof lacks justification, and that step skips a necessary step.",
    "It is false that the proof lacks justification, and that first step skips a necessary step.",
    "不能说证明缺少理由，但你的证明跳过了必要步骤。",
  ])("retains the independent critique in %s", feedback => {
    expect(independentProseClauses(feedback)).toHaveLength(2);
    const steps = incorrectEquality(identity);
    steps.steps[0]!.feedback += " " + feedback;
    expectOutcome("incorrect", steps, "incorrect");
  });

  it.each(["Step 4", "第4步", "The second step", "第二步", "2nd step", "the final step", "the last step", "最后一步"])(
    "keeps a critique of %s from authorizing a verdict on another step", label => {
      const steps = sequence(identity, "1+1=2");
      Object.assign(steps.steps[0]!, { verdict: "incorrect", feedback: "The equality is incorrect." });
      steps.steps[1]!.stepIndex = 4;
      expectOutcome("incorrect", steps, "unverified", { feedback: label + " skips a necessary step." });
      expectOutcome("incorrect", steps, "unverified", {
        criteria: [{ label, verdict: "incorrect", feedback: "Missing justification." }],
      });
    },
  );

  it.each(["The first step", "1st step", "第一步", "This step", "本步", "the penultimate step", "倒数第二步"])(
    "uses %s when it identifies the graded step", label => {
      const steps = sequence(identity, "1+1=2");
      Object.assign(steps.steps[0]!, { stepIndex: 2, verdict: "incorrect", feedback: "The equality is incorrect." });
      steps.steps[1]!.stepIndex = 4;
      const feedback = label + " skips a necessary step.";
      expectOutcome("incorrect", steps, "incorrect", { feedback });
      expectOutcome("incorrect", steps, "incorrect", {
        criteria: [{ label, verdict: "incorrect", feedback: "Missing justification." }],
      });
    },
  );
});

describe("symbolic proof feedback Round 17", () => {
  const identity = "(x+1)^2=x^2+2x+1";

  it.each([
    "The following step uses F₂.", "After this step, switch to F₂.", "从下一步起改用 F₂。",
    "The fourth step uses F₂.", "Use F₂ in the 4th step.", "第四步改用 F₂。",
    "Use F₂ in Step 4.", "Use F₂ in a previous step.", "上一步使用 F₂。",
  ])("keeps step-local domain references from advancing the current step in %s", text => {
    for (const field of ["feedback", "repairPrompt"] as const) {
      const steps = sequence("1+1=0", "Continue.", "Proceed.", "Finish.");
      steps.steps[0]![field] = text;
      expectOutcome("correct", steps, "unverified", { transcription: "Work over ℝ. 1+1=0." });
    }
    expectOutcome("correct", sequence("1+1=0", "Continue.", "Proceed.", "Finish."), "unverified", {
      transcription: "Work over ℝ. 1+1=0.", feedback: text,
    });
  });

  it.each(["The following step uses F₂.", "下一步改用 F₂。", "The second step uses F₂.", "第二步使用 F₂。"])(
    "applies a deferred local domain to its target in %s", text => {
      const steps = sequence("1+1=2", "1+1=0");
      steps.steps[0]!.repairPrompt = text;
      expectOutcome("correct", steps, "correct");
    },
  );

  it("keeps a relative switch after the second transcribed claim attached to the third step", () => {
    expectOutcome("correct", sequence("2+2=4", "1+1=0", "Continue."), "unverified", {
      transcription: "Work over ℝ. 2+2=4. 1+1=0, but the following step uses F₂. Continue.",
    });
    expectOutcome("correct", sequence("2+2=4", "1+1=2", "1+1=0"), "correct", {
      transcription: "Work over ℝ. 2+2=4. 1+1=2, but the following step uses F₂. 1+1=0.",
    });
  });

  it("resolves ordinals by proof position and explicit labels by step index", () => {
    const steps = sequence("1+1=2", "1+1=0");
    steps.steps[1]!.stepIndex = 4;
    steps.steps[0]!.feedback = "The second step uses F₂.";
    expectOutcome("correct", steps, "correct");
    steps.steps[0]!.feedback = "Step 4 uses F₂.";
    expectOutcome("correct", steps, "correct");
    steps.steps[0]!.feedback = "The fourth step uses F₂.";
    expectOutcome("correct", steps, "unverified");
  });

  it.each(["the fourth step", "the 4th step", "第四步", "the last step"])(
    "applies the domain to %s when it is current", scope => {
      expectOutcome("correct", sequence("1+1=2", "Continue.", "Proceed.", "1+1=0"), "correct", {
        transcription: "Work over ℝ. 1+1=2. Continue. Proceed. 1+1=0.",
        feedback: 'Use F₂ in ' + scope + '.',
      });
    },
  );

  it.each([
    [", but the fourth step uses F₂.", "unverified"], [", and the 4th step uses F₂.", "unverified"],
    [", but the twenty-first step uses F₂.", "unverified"], ["，但第四步使用 F₂。", "unverified"],
    [", because in this first step we use F₂.", "correct"], ["，因为第一步在 F₂ 中计算。", "correct"],
    [", because for this step we switch to F₂.", "correct"], [", for this step, switch to F₂.", "correct"],
    [", in this current step we now switch to F₂.", "correct"], ["，在本步中改用 F₂。", "correct"],
    [", after working in this step we switch to F₂.", "unverified"],
    [", until this step ends, then switch to F₂.", "unverified"],
  ] as const)("scopes the transcribed domain qualifier in %s", (suffix, expected) => {
    expectOutcome("correct", sequence("1+1=0", "Continue.", "Proceed.", "Finish."), expected, {
      transcription: `Work over ℝ. 1+1=0${suffix}`,
    });
  });

  it.each([
    ["The worksheet reads ‘the student’s result gives a contradiction’.", "unverified"],
    ["The worksheet reads ‘the students’ result gives a contradiction’.", "unverified"],
    ["The worksheet reads ‘the students’ result gives a contradiction and ‘nothing follows’.", "correct"],
    ["This ‘result’ gives a contradiction and ‘ends the calculation’.", "correct"],
    ["讲义写着‘该结果导出矛盾’。", "unverified"],
    ["该结果导出矛盾。", "correct"],
  ] as const)("distinguishes a quoted contradiction from an assertion in %s", (text, expected) => {
    expectOutcome("correct", sequence("Assume x=0.", "1=0", text), expected);
  });

  it.each([
    ["The rubric gives “the proof lacks justification” as an example of feedback.", "unverified"],
    ["The rubric uses missing justification as a model comment.", "unverified"],
    ["评分细则把‘缺少理由’作为反馈样例。", "unverified"],
    ["The proof lacks justification.", "incorrect"], ["证明缺少理由。", "incorrect"],
    ["Your division by $0$ invalidates the argument.", "incorrect"],
    ["It is false that the conclusion does not follow.", "unverified"],
    ["The claim that the conclusion cannot follow is groundless.", "unverified"],
    ["It is false that you assume what you need to prove.", "unverified"],
    ["It is false that you divide by x without checking that x is nonzero.", "unverified"],
    ["It is false that your division by $0$ invalidates the argument.", "unverified"],
    ["The conclusion does not follow.", "incorrect"], ["The conclusion fails to follow.", "incorrect"],
    ["你不能说这个证明缺少理由。", "unverified"],
    ["It is false that the proof lacks justification, and that it skips a necessary step.", "unverified"],
    ["It is false that the proof lacks justification, and that calculations omit a necessary step.", "unverified"],
    ["It is false that the proof lacks justification and skips a necessary step.", "unverified"],
    ["不能说证明缺少理由，也不能说它跳过了必要步骤。", "unverified"],
    ["认为证明缺少理由且跳步是错误的。", "unverified"],
    ["认为证明缺少理由，且跳步是错误的。", "unverified"],
    ["It is false that the proof is circular, but your proof skips a necessary step.", "incorrect"],
    ["It is false that the proof lacks justification, and that step skips a necessary step.", "incorrect"],
    ["不能说证明缺少理由，但该证明跳过了必要步骤。", "incorrect"],
  ] as const)("checks asserted inference feedback in %s", (feedback, expected) => {
    expectOutcome("incorrect", incorrectEquality(identity), expected, { feedback });
  });

  it.each([
    "The rubric gives “the equality is incorrect” as an example.",
    "The rubric gives “the identity holds only when x=0” as an example.",
    "评分细则将‘等式不成立’作为反馈示例。",
    "评分细则将‘等式仅在 x=0 时成立’作为反馈示例。",
  ])("keeps an illustrative equality objection out of the verdict in %s", feedback => {
    expectOutcome("incorrect", proof(identity, "incorrect"), "incorrect", { feedback });
  });
});

describe("symbolic proof feedback Round 11", () => {
  const identity = "(x+1)^2=x^2+2x+1";

  it.each(["1+1=0", "Step 1: $1+1=0$.", "x+1=x+2"])(
    "1. keeps a transcribed later switch out of the step %s", claim => {
      expectOutcome("correct", sequence(claim, "Now switch to F₂."), "unverified", {
        transcription: "Work over ℝ. 1+1=0. Now switch to F₂.",
      });
    },
  );

  it("1. uses the transcribed finite field for steps after the switch", () => {
    expectOutcome("correct", sequence("1+1=2", "Now switch to F₂.", "1+1=0"), "correct", {
      transcription: "Work over ℝ. 1+1=2. Now switch to F₂. 1+1=0.",
    });
  });

  it.each<ProposalContext>([
    { transcription: "Work over ℝ. Step 2: Work over F₂." },
    { feedback: "Work over ℝ. 第 2 步切换到 F₂。" },
    { transcription: "Work over ℝ. Step 2: Work over F₂. 1+1=0. Continue." },
  ])("1. defers a numbered domain clause in %o", context => {
    expectOutcome("correct", sequence("1+1=0", "Continue."), "unverified", context);
  });

  it.each([
    "Work over ℝ. What would change over F₂?",
    "Work over ℝ, and check whether it holds over F₂.",
    "Work over ℝ. Consider what would change over F₂.",
    "Work over ℝ. If we instead worked over F₂, the result could differ.",
    "Work over ℝ. “Does it hold over F₂？”",
  ])("2. ignores a question or hypothetical domain in %s", feedback => {
    expectOutcome("correct", proof("1+1=0", "correct"), "unverified", { feedback });
  });

  it("2. recognizes a transcribed question before cutting at a matched equation", () => {
    expectOutcome("correct", proof("1+1=0", "correct"), "unverified", {
      transcription: "Work over ℝ. Would F₂ give 1+1=0?",
    });
  });

  it.each([
    "Have we obtained a contradiction at x=1.5?",
    "“Have we obtained a contradiction at $x=1.5$?”",
    "（是否在 $$x=1.5$$ 时得出矛盾？）",
  ])("3. keeps a decimal inside the contradiction question %s", feedback => {
    const steps = sequence("Assume x is positive.", "1=0");
    steps.steps[1]!.feedback = feedback;
    expectOutcome("correct", steps, "unverified");
  });

  it("3. recognizes a contradiction asserted at a decimal value after a question", () => {
    const steps = sequence("Assume x is positive.", "1=0");
    steps.steps[1]!.feedback = "“Does it hold at x=2?” At x=1.5, we obtain a contradiction.";
    expectOutcome("correct", steps, "correct");
  });

  it.each([
    "We seek a contradiction.", "A contradiction might follow.", "This may be a contradiction.",
    "We could reject the hypothesis.", "可能得出矛盾。", "矛盾也许会出现。",
  ])("4. requires discharge when feedback only says %s", feedback => {
    const steps = sequence("Assume x is positive.", "1=0");
    steps.steps[1]!.feedback = feedback;
    expectOutcome("correct", steps, "unverified");
  });

  it("4. does not exempt a single false calculation with bare intent", () => {
    const steps = sequence("1=0");
    steps.steps[0]!.feedback = "We seek a contradiction.";
    expectOutcome("correct", steps, "unverified");
  });

  it.each([
    "There is no circular reasoning.", "Did you use circular reasoning at x=1.5?",
    "We avoided assuming the conclusion.", "You didn't divide by x without proving it was nonzero.",
    "没有缺少推导。", "Your proof is free of missing steps.", "You did not skip any intermediate steps.",
  ])("5. rejects a negated or interrogative critique in %s", feedback => {
    const steps = incorrectEquality(identity, feedback);
    steps.steps[0]!.repairPrompt = "The equality is incorrect.";
    expectOutcome("incorrect", steps, "unverified");
  });

  it.each(["There is no justification.", "The conclusion does not follow.", "You divided by x without justification."])(
    "5. retains the affirmative inference critique %s", feedback => {
      const steps = incorrectEquality(identity, feedback);
      steps.steps[0]!.repairPrompt = "The equality is incorrect.";
      expectOutcome("incorrect", steps, "incorrect");
    },
  );

  it.each(["Work over ℂ, a field of characteristic 0.", "Work over ℂ. char(K) = 0."])(
    "6. preserves the non-real domain in %s", transcription => {
      expectOutcome("incorrect", incorrectEquality("abs(x)^2=x^2"), "incorrect", { transcription });
    },
  );

  it("6. treats a field explicitly not of characteristic zero as non-real", () => {
    expectOutcome("correct", proof("1+1=0", "correct"), "correct", { feedback: "K is not of characteristic 0." });
  });

  it("7. retains pending inner rejection across a neutral step", () => {
    const steps = sequence("Assume P.", "Assume Q.", "1=0", "Record that result.",
      "Reject the inner assumption.", "1=0", "Reject the outer assumption.");
    steps.steps[2]!.feedback = "This is the derived contradiction.";
    expectOutcome("correct", steps, "correct");
  });

  it("7. does not let a pending inner discharge swallow an explicit outer rejection", () => {
    const steps = sequence("Assume P.", "1=0", "Assume Q.", "1=0", "Reject the outer assumption.");
    steps.steps[3]!.feedback = "This is the derived contradiction.";
    expectOutcome("correct", steps, "correct");
  });

  it("7. does not pop the bottom frame for a named inner rejection", () => {
    const steps = sequence("Assume P.", "1=0", "Reject the inner assumption.");
    expectOutcome("correct", steps, "unverified");
  });

  it.each([
    "You assumed the two expressions do not equal zero without justification.",
    "You assumed that both values do not equal $1$ without justification.",
    "未经证明就声称等式两边不等于零。",
  ])("8. preserves inference feedback involving a shared operand in %s", feedback => {
    expectOutcome("incorrect", incorrectEquality(identity, feedback), "incorrect");
  });

  it("9. accepts a proposal-level critique alongside a step equality dispute", () => {
    expectOutcome("incorrect", incorrectEquality(identity), "incorrect", { feedback: "Circular reasoning." });
  });

  it.each([
    "The equality is incorrect and you used circular reasoning.",
    "The equality is incorrect, moreover you skipped the proof.",
    "等式不成立并且使用了循环论证。",
  ])("9. recognizes an independent critique in %s", feedback => {
    expectOutcome("incorrect", incorrectEquality(identity, feedback), "incorrect");
  });

  it.each([
    ["\\frac{d}{dx}(x^3) = 3x^2", "The left side ≠ the right side."],
    ["\\int 2x\\,dx = x^2 + C", "等号左边不等于等号右边。"],
    ["\\frac{d}{dx}(x^3) = 3x^2", "The claim is \\frac{d}{dx}(x^3) \\neq 3x^2."],
    ["\\int 2x\\,dx = x^2 + C", "The claim is \\int 2x\\,dx \\neq x^2 + C."],
  ])("10. recognizes a denial of %s in %s", (claim, feedback) => {
    expect(verifyStandaloneProofEquationClaim(claim).unconditional).toBe(true);
    expectOutcome("incorrect", incorrectEquality(claim, feedback), "unverified");
  });

  it("handles 6,000-character domain and inference inputs with repeated near matches", () => {
    const characteristic = "Work over ℝ. characteristic of ";
    const domainSwitch = ". Work over ℝ.";
    const domains = "not where ℝ and F₂ ".repeat(320).slice(0, 6_000 - domainSwitch.length);
    expectOutcome("correct", proof("1+1=0", "correct"), "unverified", {
      feedback: domains + domainSwitch,
    });
    expectOutcome("correct", proof("1+1=0", "correct"), "unverified", {
      feedback: characteristic + " ".repeat(6_000 - characteristic.length - 2) + "K.",
    });
    expectOutcome("incorrect", incorrectEquality(identity), "unverified", {
      feedback: "等式仅在".repeat(1_500),
    });
  });
});

describe("symbolic proof feedback Round 12", () => {
  const identity = "(x+1)^2=x^2+2x+1";

  it.each(["1+1=0", "Step 1: $1+1=0$.", "2+2=0"])(
    "1. keeps a later switch out of the spaced or unmatched step %s", claim => {
      expect(verifyStandaloneProofEquationClaim(claim).status).toBe("inequivalent");
      expectOutcome("correct", sequence(claim, "Continue."), "unverified", {
        transcription: "Work over ℝ. $1 + 1 = 0$. Now switch to F₂. Continue.",
      });
    },
  );

  it("1. keeps a leading domain preamble for an unmatched step", () => {
    expectOutcome("correct", sequence("2+2=0", "Continue."), "correct", {
      transcription: "Work over F₂. 1+1=0. Now switch to ℝ. Continue.",
    });
  });

  it.each([
    "Work over ℝ. The result would change if we switched to F₂.",
    "Work over ℝ, whereas if we switched to F₂, the result would change.",
    "Work over ℝ. We could work over F₂ instead.",
    "在实数域中计算。如果切换到 F₂，结果就会改变。",
  ])("2. keeps a hypothetical field from replacing the asserted field in %s", feedback => {
    expectOutcome("correct", proof("1+1=0", "correct"), "unverified", { feedback });
  });

  it.each([
    "The claimed contradiction is invalid.",
    "This is a spurious contradiction.",
    "If we obtain a contradiction, stop.",
    "Stop when we obtain a contradiction.",
    "如果得出矛盾，就停止。",
    "这个矛盾不成立。",
  ])("3. keeps a supposition open when feedback says %s", feedback => {
    const steps = sequence("Assume x is positive.", "1=0");
    steps.steps[1]!.feedback = feedback;
    expectOutcome("correct", steps, "unverified");
  });

  it("3. does not exempt a standalone equation through a conditional contradiction", () => {
    const steps = sequence("1=0");
    steps.steps[0]!.feedback = "If this gives a contradiction, stop.";
    expectOutcome("correct", steps, "unverified");
  });

  it("3. recognizes an asserted rejection after opening with a conditional", () => {
    const steps = sequence("If x+1=x, subtract x.", "1=0");
    steps.steps[1]!.feedback = "The assumption is false.";
    expectOutcome("correct", steps, "correct");
  });

  it.each([
    "Check whether you used circular reasoning.",
    "Verify if you assumed the conclusion.",
    "Circular reasoning is absent.",
    "Division by $0$ did not occur.",
    "Missing justification was not found.",
    "循环论证并不存在。",
    "请检查是否使用了循环论证。",
  ])("4. ignores a non-asserted inference defect in %s", feedback => {
    expectOutcome("incorrect", incorrectEquality(identity), "unverified", { feedback });
  });

  it.each<ProposalContext>([
    { feedback: "Step 2 uses circular reasoning." },
    { feedback: "The equality is wrong because Step 2 uses circular reasoning." },
    { feedback: "第 2 步使用了循环论证。" },
    { criteria: [{ label: "Step 2", verdict: "incorrect", feedback: "Circular reasoning." }] },
    { criteria: [{ label: "Inference", verdict: "incorrect", feedback: "Step 2 uses circular reasoning." }] },
  ])("5. keeps critique of an optional step from authorizing a required grade in %o", context => {
    const steps = incorrectEquality(identity);
    steps.steps.push({ ...steps.steps[0]!, stepIndex: 2, claim: "P implies P.", required: false });
    expectOutcome("incorrect", steps, "unverified", context);
  });

  it.each<ProposalContext>([
    { feedback: "Step 2 uses circular reasoning, but Step 1 skips the proof." },
    { feedback: "Circular reasoning is present; Step 2 has a typo." },
    { criteria: [{ label: "Step 1", verdict: "incorrect", feedback: "Circular reasoning." }] },
  ])("5. keeps critique applicable to the required step in %o", context => {
    const steps = incorrectEquality(identity);
    steps.steps.push({ ...steps.steps[0]!, stepIndex: 2, claim: "P implies P.", required: false });
    expectOutcome("incorrect", steps, "incorrect", context);
  });

  it.each<ProposalContext>([
    { feedback: "Step 2: the equality is incorrect." },
    { criteria: [{ label: "Step 2", verdict: "incorrect", feedback: "The equality is incorrect." }] },
  ])("5. does not dispute a different step's identity in %o", context => {
    const steps = incorrectEquality(identity, "Review the inference.");
    steps.steps.push({ ...steps.steps[0]!, stepIndex: 2, claim: "P implies P.", required: false });
    expectOutcome("incorrect", steps, "incorrect", context);
  });

  it("6. finds the asserted occurrence after the same equation in a question", () => {
    expectOutcome("correct", proof("1+1=0", "correct"), "correct", {
      transcription: "Work over ℝ. Is 1+1=0? Work over F₂. We then obtain 1+1=0.",
    });
  });

  it.each(["1+1=0 in F₂.", "1 + 1 = 0 in F₂. Work over ℝ. Continue."])(
    "7. includes a field qualifier after the equation in %s", transcription => {
      expectOutcome("correct", sequence("1+1=0", "Continue."), "correct", { transcription });
    },
  );

  it("7. stops at the next matched step that shares a sentence", () => {
    expectOutcome("correct", sequence("1+1=0", "Work over F₂"), "unverified", {
      transcription: "Work over ℝ. 1+1=0; Work over F₂.",
    });
  });

  it("7. does not locate an alphabetic step inside another word", () => {
    expectOutcome("correct", sequence("x", "1+1=0"), "correct", {
      transcription: "Work over ℝ. Next, 1+1=0. Work over F₂. x.",
    });
  });

  it.each([String.raw`\frac{d}{dx}(x^3) = 3x^2`, String.raw`\int 2x\,dx = x^2 + C`])(
    "8. recognizes a reverse-order denial of %s", claim => {
      expectOutcome("incorrect", incorrectEquality(claim, "The right side ≠ the left side."), "unverified");
    },
  );

  it("handles 6,000 characters of questions and unsuccessful near matches before an assertion", () => {
    const asserted = "Work over F₂. 1 + 1 = 0 in F₂.";
    const prefix = "Is 1+1=0? 1+1=2. ".repeat(400).slice(0, 6_000 - asserted.length - 1);
    expectOutcome("correct", proof("1+1=0", "correct"), "correct", {
      transcription: prefix + "\n" + asserted,
    });
    const defect = "circular reasoning.";
    expectOutcome("incorrect", incorrectEquality(identity), "unverified", {
      feedback: "Check whether ".repeat(420).padEnd(6_000 - defect.length) + defect,
    });
  });
});

describe("symbolic proof feedback Round 13", () => {
  const identity = "(x+1)^2=x^2+2x+1";

  it.each([
    "由矛盾知原假设不成立。",
    "矛盾说明原假设不成立。",
    "矛盾表明前提不成立。",
    "矛盾表明原假定不成立。",
  ])("discharges the assumption when its rejection follows from a contradiction in %s", discharge => {
    expectOutcome("correct", sequence("Assume x+1=x.", "1=0", discharge), "correct");
  });

  it.each(["所谓矛盾不成立。", "该矛盾无效。"])(
    "leaves the assumption open when the contradiction itself is rejected in %s", discharge => {
      expectOutcome("correct", sequence("Assume x+1=x.", "1=0", discharge), "unverified");
    },
  );

  it.each([
    "跳步且没有给出理由。",
    "直接假设没有依据。",
    "等式不成立且没有依据。",
    "等式不成立且未提供证明。",
  ])("retains a required incorrect verdict for an independent inference defect in %s", feedback => {
    expectOutcome("incorrect", incorrectEquality(identity), "incorrect", { feedback });
  });

  it.each([
    "循环论证不存在。",
    "循环论证没有出现。",
    "这里循环论证没有。",
    "并非没有依据。",
    "没有缺少理由。",
  ])("does not accept an incorrect verdict based on a denied inference defect in %s", feedback => {
    expectOutcome("incorrect", incorrectEquality(identity), "unverified", { feedback });
  });
});

describe("symbolic proof feedback Round 14", () => {
  const identity = "(x+1)^2=x^2+2x+1";

  it.each([
    ...["refute", "reject", "disprove", "discharge", "falsify", "negate", "contradict"].map(
      verb => "The contradiction does not " + verb + " the assumption.",
    ),
    "The contradiction does not show that the assumption is false.",
    "The contradiction does not, by itself, refute the assumption.",
    "The contradiction does not, however, discharge the assumption.",
    "The assumption is not refuted.", "The assumption is not false.", "The assumption is not impossible.",
    "We cannot conclude that the assumption is false.", "This might disprove the hypothesis.",
    "We still need to falsify the assumption.", "The assumption is yet to be discharged.",
    "不能据此断定原假设不成立。", "不足以说明原假设不成立。", "并未证明假设不成立。",
    "还不能据此，断定原假设不成立。",
    "原假设并非不成立。", "无法由此推出该前提错误。", "未能得出原假定不成立。",
    "原假设是否不成立，仍需证明。", "或许可以推翻该假定。",
  ])("1. keeps the entire denied or pending rejection non-assertive in %s", rejection => {
    expectOutcome("correct", sequence("Assume x=0.", "1=0", rejection), "unverified");
  });

  it.each([
    "The contradiction shows the assumption is false.", "The contradiction refutes the assumption.",
    "The contradiction discharges the hypothesis.", "The hypothesis is falsified.",
    "由矛盾知原假设不成立。", "矛盾说明原假设不成立。", "原假定错误。", "由此推翻该前提。",
  ])("1. discharges on the asserted rejection in %s", rejection => {
    expectOutcome("correct", sequence("Assume x=0.", "1=0", rejection), "correct");
  });

  it.each([
    ...["definition", "meaning", "concept", "notion", "principle", "form", "example", "use", "rule"].map(
      noun => "The " + noun + " of contradiction is standard.",
    ),
    "Recall the notion of contradiction.", "The contradiction appears in the glossary.",
    "We have a definition of contradiction.", "This is a contradiction rule.",
    "It is impossible to derive a contradiction.", "This is absurd to call a contradiction.",
    "The absurdity of the notation is discussed in class.",
    "矛盾的定义是标准的。", "复习矛盾的概念和含义。", "介绍矛盾的形式或规则。", "这是一种导出矛盾的规则。",
  ])("2. does not discharge a supposition on a mention in %s", mention => {
    expectOutcome("correct", sequence("Assume x=0.", "1=0", mention), "unverified");
  });

  it.each([
    "Contradiction.", "This is a contradiction.", "This is the derived contradiction.", "1=0, a contradiction.",
    ...["reaches", "yields", "gives", "derives", "leads to", "results in", "produces", "obtains", "shows"].map(
      verb => "This " + verb + " a contradiction.",
    ),
    "We have a contradiction.", "This contradicts the premise.", "This is in contradiction with x=0.",
    "We obtain 1=0, which is impossible.", "That result, which is absurd.", "The result follows by reductio.",
    "矛盾。", ...["导出", "推出", "得到", "得出", "产生", "出现", "构成"].map(verb => verb + "矛盾。"),
    "自相矛盾。", "这与前提矛盾。", "由此矛盾。", "这很荒谬。", "这显然是荒谬的。",
  ])("2. recognizes an asserted contradiction in %s", assertion => {
    expectOutcome("correct", sequence("Assume x=0.", "1=0", assertion), "correct");
  });

  it.each(["11+1=0", "0.1+1=0", "1+1=01", "a1+1=0", "𝑎1+1=0", "-1+1=0", "- 1+1=0",
    "x_1+1=0", "x^1+1=0", "\\a1+1=0", "1+1=0^2", "1+1=0.1", "1+1=0+1", "1+1=0 + 1", "1+1=0/2"])(
    "3. finds the standalone real equation after the earlier token %s", embedded => {
      expectOutcome("correct", sequence("1+1=0"), "unverified", {
        transcription: "Work over F₂. " + embedded + ". Now work over ℝ. 1+1=0.",
      });
    },
  );

  it.each([["x=0", "2x=0"], ["x=0", "2 x=0"], ["x=0", "x_1=0"], ["1=0", "x_1=0"], ["2=0", "x^2=0"],
    ["alpha=0", "\\alpha=0"], ["1=0", "x^{1=0}"]])(
    "3. locates %s in the real domain instead of inside %s", (claim, embedded) => {
      const steps = sequence(claim).steps;
      const transcription = "Work over F₂. " + embedded + ". Now work over ℝ. " + claim + ".";
      expect(proofStepUsesRealScalar(steps, transcription, []).get(steps[0]!)).toBe(true);
    },
  );

  it.each(["$1+1=0$", "$$1+1=0$$", "(1+1=0)", "1+1=0.", "1+1=0;", "Step 1: 1+1=0", "1 + 1 = 0"])(
    "3. binds a field to the delimited math %s", claim => {
      expectOutcome("correct", sequence("1+1=0"), "correct", {
        transcription: "Work over F₂. " + claim + "\nNow work over ℝ. 1+1=0.",
      });
    },
  );

  it.each([
    "; now switch to F₂.", ", then switch to F₂.", ", and we now work over F₂.",
    " and work over F₂.", ", work over F₂.", ", we work over F₂.",
    "；随后改在 F₂。", "，然后改在 F₂。", "且改在 F₂。",
  ])("4. keeps a later field switch out of the equation in %s", transition => {
    expectOutcome("correct", sequence("1+1=0"), "unverified", {
      transcription: "Work over ℝ. 1+1=0" + transition,
    });
  });

  it.each([" in F₂.", " over GF(2).", " (mod 2).", "，其中特征为 2。", ", in F₂, then work over ℝ."])(
    "4. associates an attached qualifier with the equation in %s", qualifier => {
      expectOutcome("correct", sequence("1+1=0"), "correct", {
        transcription: "Work over ℝ. 1+1=0" + qualifier,
      });
    },
  );

  it("4. passes the new domain on to the following step", () => {
    expectOutcome("correct", sequence("1+1=2", "1+1=0"), "correct", {
      transcription: "Work over ℝ. 1+1=2, then switch to F₂. 1+1=0.",
    });
  });

  it.each([
    "所谓缺少理由的问题不存在。", "没有给出理由的情况并不存在。", "未经证明的问题未出现。",
    "缺少推导的现象从未出现。", "禁止使用该定理的情况并不存在。", "不得采用此方法的问题没有发生。",
    "The issue of missing justification does not exist.", "Lack of justification is absent.",
    "Skipping a necessary step did not occur.", "Omitting required steps never happened.",
    "Use of a forbidden theorem did not occur.", "The concern about missing proof is unfounded.",
  ])("5. discards the denied critique in %s", feedback => {
    expectOutcome("incorrect", incorrectEquality(identity), "unverified", { feedback });
  });

  it.each(["跳步且没有给出理由。", "直接假设没有依据。", "未经证明就用了该定理。", "Skipping a necessary step is a problem."])(
    "5. retains the asserted inference critique in %s", feedback => {
      expectOutcome("incorrect", incorrectEquality(identity), "incorrect", { feedback });
    },
  );

  it.each([
    "Check whether the expansion is valid, but the proof skips a necessary step.",
    "Check whether the expansion is valid, however it begs the question.",
    "Check whether the expansion is valid. The proof skips a necessary step.",
    "If the expansion is valid, the decision stands, but the proof skips a necessary step.",
    "请检查是否展开正确，但这一步缺少理由。", "请检查是否展开正确，此外还有跳步。",
  ])("6. keeps an independent critique after non-assertive text in %s", feedback => {
    expectOutcome("incorrect", incorrectEquality(identity), "incorrect", { feedback });
  });

  it.each([
    "Check whether the expansion is valid or skips a necessary step.",
    "Check whether the proof skips a necessary step and lacks justification.",
    "Check whether the proof is accurate, but skips a necessary step when x=0.",
    "If the proof skips a necessary step, add it.",
    "请检查是否展开正确或者缺少理由。", "请检查是否跳步并且缺少理由。",
  ])("6. keeps a coordinated indirect critique or conditional non-assertive in %s", feedback => {
    expectOutcome("incorrect", incorrectEquality(identity), "unverified", { feedback });
  });

  it.each(["设", "先设", "现设", "暂且设", "反设", "假定", "先假定"])(
    "7. opens a Chinese supposition using %s", assumption => {
      const opening = assumption + " x+1=x。";
      expectOutcome("correct", sequence(opening, "1=0", "由矛盾知原假设不成立。"), "correct");
      expectOutcome("correct", sequence(opening, "1=0"), "unverified");
    },
  );

  it.each(["设置", "设计", "设备", "设施", "设想", "设定为"])(
    "7. does not treat %s as stating a supposition", prefix => {
      expectOutcome("correct", sequence(prefix + " x+1=x。", "1=0", "由矛盾知原假设不成立。"), "unverified");
    },
  );

  it.each([10, 20, 40])("8. reads transcription characters linearly for %s distinct misses", stepCount => {
    const length = stepCount * 296;
    const steps = sequence(...Array.from({ length: stepCount }, (_, index) => "x=" + index)).steps;
    const originalPush = Array.prototype.push;
    let characterReads = 0;
    // Count reads of the unique transcription character without relying on a wall-clock threshold.
    Array.prototype.push = function (this: unknown[], ...values: unknown[]) {
      const end = Reflect.apply(originalPush, this, values) as number;
      if (values.length === 1 && values[0] === "§") {
        Object.defineProperty(this, end - 1, {
          configurable: true,
          get: () => { characterReads++; return "§"; },
        });
      }
      return end;
    };
    try {
      proofStepUsesRealScalar(steps, "§".repeat(length), []);
    } finally {
      Array.prototype.push = originalPush;
    }
    expect(characterReads).toBeGreaterThanOrEqual(length);
    expect(characterReads).toBeLessThanOrEqual(2 * length);
  });

  it("8. consumes repeated transcribed claims in step order across a field switch", () => {
    const steps = sequence("1+1=0", "1+1=0", "1+1=0").steps;
    const usesReal = proofStepUsesRealScalar(steps, "Work over F₂. 11+1=0. $1+1=0$. Work over ℝ. 1+1=0. 1+1=0.", []);
    expect(steps.map(step => usesReal.get(step))).toEqual([false, true, true]);
  });

  it("6. keeps an asserted proof role after an independent contrast", () => {
    expectOutcome("correct", sequence("Assume x=0.", "1=0",
      "Check whether this expansion is valid, but this is a contradiction."), "correct");
    expectOutcome("correct", sequence("Assume x=0.", "1=0",
      "Check whether the expansion is valid or gives a contradiction."), "unverified");
  });

  it("8. locates a mixed prose and math step when it has no fully unwrapped candidate", () => {
    const steps = sequence("We obtain $x=0$.", "1+1=0").steps;
    const transcription = "Work over F₂. We obtain $x=0$. Work over ℝ. 1+1=0.";
    const usesReal = proofStepUsesRealScalar(steps, transcription, []);
    expect(steps.map(step => usesReal.get(step))).toEqual([false, true]);
  });

  it("8. finds a valid suffix of another candidate without consuming its later occurrence", () => {
    const steps = sequence("1+1=0", "Check 1+1=0").steps;
    const transcription = "Work over F₂. Check 1+1=0. Work over ℝ. Check 1+1=0.";
    const usesReal = proofStepUsesRealScalar(steps, transcription, []);
    expect(steps.map(step => usesReal.get(step))).toEqual([false, true]);
  });

  it("retains deterministic teaching evaluation of a grouped equation", () => {
    expect(check(algebra, choice(quadratic, "x^2+1"), "A", "A. " + quadratic)).toBe("correct");
    expect(check(algebra, choice(quadratic, "x^2+1"), "A", "B. x^2+1")).toBe("incorrect");
  });
});

describe("symbolic proof feedback Round 15", () => {
  const identity = "(x+1)^2=x^2+2x+1";

  it.each([
    ...["if", "only if", "unless", "in case", "whenever", "provided", "assuming", "supposing", "on condition that"].flatMap(
      word => [`The assumption is false ${word} the last equality holds.`, `${word} the last equality holds, the assumption is false.`],
    ),
    ...["如果", "若", "倘若", "要是", "一旦", "除非", "只有", "只要", "前提是", "当且仅当"].flatMap(
      word => [`原假设不成立${word}末式成立。`, `${word}末式成立，原假设不成立。`],
    ),
    ...["unproved", "unproven", "unverified", "open", "pending", "doubtful"].map(word => `The assumption is false remains ${word}.`),
    ...["claim", "assertion", "statement", "conclusion", "idea"].map(word => `The ${word} that the assumption is false remains unproved.`),
    ...["unjustified", "unsupported", "unestablished", "questionable", "uncertain", "disputed", "premature", "false", "wrong", "incorrect", "invalid", "mistaken"].map(
      word => `The claim that the assumption is false is ${word}.`,
    ),
    "The assertion that we reject the assumption has not been shown.",
    "Consider the assertion that the assumption is false.",
    "The claim that the assumption is false, even in its weakest form, remains unproved.",
    "原假设不成立的说法有待证明。", "原假设不成立这一断言存疑。", "原假设不成立这一观点站不住脚。",
    "原假设不成立这一结论错误。", "原假设不成立该判断未经证实。",
  ])("1. leaves the supposition open when the rejection is conditional or pending in %s", rejection => {
    expectOutcome("correct", sequence("Assume x=0.", "1=0", rejection), "unverified");
  });

  it.each([
    "Since x=0 gives 1=0, the assumption is false.",
    "When we substitute x=0, we obtain 1=0, so the assumption is false.",
    "This refutes the hypothesis, so the assumption is false.",
    "We conclude that the assumption is false.",
    "当我们代入 x=0，得到 1=0，因此原假设不成立。",
  ])("1. preserves an independently asserted deduction in %s", rejection => {
    expectOutcome("correct", sequence("Assume x=0.", "1=0", rejection), "correct");
  });

  it.each([
    ...["after which", "whereupon", "from which point", "following which", "at which point"].map(word => `, ${word} we switch to F₂.`),
    ...["subsequently", "thereafter", "afterward", "later", "from now on", "hereafter", "in the next step", "for the rest"].map(word => ` and we will ${word} switch to F₂.`),
    ...["随后", "然后", "接下来", "此后", "之后", "接着", "继而", "下面"].map(word => `，我们${word}在 F₂ 中计算。`),
    ", we shall change to F₂.", ", she will move to F₂.", "；现在改为 F₂。",
  ])("2. keeps a later field switch from applying retroactively in %s", transition => {
    expectOutcome("correct", sequence("1+1=0"), "unverified", {
      transcription: "Work over ℝ. 1+1=0" + transition,
    });
  });

  it.each([" in F₂.", " over GF(2).", " (mod 2).", ", where char(F)=2.", "，其中特征为 2。"])(
    "2. retains an attached field qualifier in %s", qualifier => {
      expectOutcome("correct", sequence("1+1=0"), "correct", {
        transcription: "Work over ℝ. 1+1=0" + qualifier,
      });
    });

  it.each([
    "The word of the day is contradiction.",
    ...["term", "terminology", "vocabulary", "topic", "subject", "theme", "title", "name", "label", "concept", "notion", "definition", "meaning", "section", "chapter", "lesson", "example", "exercise", "question", "sense", "spelling"].map(
      noun => `The ${noun} of this lesson is a contradiction.`,
    ),
    "The lesson gives a contradiction.", "For today, the word of the day is a contradiction.",
    "The following technical term is a contradiction.",
    'This is a "contradiction".', "'contradiction'.", '"contradiction".',
    "“矛盾”。", "「矛盾」。", "本节介绍与逻辑矛盾有关的术语。", "这与逻辑矛盾相关。", "我们讨论导出矛盾的概念。",
  ])("3. leaves a lexical contradiction mention non-assertive in %s", mention => {
    expectOutcome("correct", sequence("Assume x=0.", "1=0", mention), "unverified");
  });

  it.each(["contradiction", "矛盾"])("3. bounds whitespace passed to the %s assertion matcher", word => {
    const originalTest = RegExp.prototype.test;
    const whitespace = " ".repeat(4096);
    let unnormalized = 0;
    RegExp.prototype.test = function (this: RegExp, value: string) {
      if (this.source.includes("归谬") && typeof value === "string" && value.includes(whitespace)) unnormalized++;
      return Reflect.apply(originalTest, this, [value]) as boolean;
    };
    try {
      expectOutcome("correct", sequence("Assume x=0.", "1=0", `The text,${whitespace}${word}${whitespace}is pending.`), "unverified");
    } finally {
      RegExp.prototype.test = originalTest;
    }
    expect(unnormalized).toBe(0);
  });

  it.each(["1+1=0!", "1+1=0! + 1", "1+1=0! = 1", "1+1=0!!", "1+1=0 x", "1+1=0 \\alpha", "1+1=0 (x+1)", "1+1=0 2"])(
    "4. finds the later real claim instead of a prefix of %s", embedded => {
      expectOutcome("correct", sequence("1+1=0"), "unverified", {
        transcription: `Work over F₂. ${embedded}. Now work over ℝ. 1+1=0.`,
      });
    });

  it.each([["x=0", "y x=0"], ["x=0", "(x+1) x=0"], ["x=0", "n! x=0"], ["x=0", "\\alpha x=0"],
    ["1+1=0", "x 1+1=0"], ["(x+1)=0", "2 (x+1)=0"]])("4. does not find %s inside %s", (claim, embedded) => {
    const steps = sequence(claim).steps;
    const transcription = `Work over F₂. ${embedded}. Now work over ℝ. ${claim}.`;
    expect(proofStepUsesRealScalar(steps, transcription, []).get(steps[0]!)).toBe(true);
  });

  it("4. keeps a bare factorial attached to an operand at the end of a line", () => {
    expectOutcome("correct", sequence("1+1=0"), "unverified", {
      transcription: "Work over F₂. 1+1=0!\nNow work over ℝ. 1+1=0.",
    });
  });

  it.each([
    ...["false", "wrong", "incorrect", "invalid", "mistaken", "untrue", "baseless", "groundless", "meritless", "erroneous", "bogus", "spurious", "misplaced", "inaccurate", "unproven", "unsubstantiated", "unsupported", "rejected", "refuted", "disproved"].map(
      word => `The claim of missing justification is ${word}.`,
    ),
    "The charge of missing justification fails.", "The criticism of missing justification collapses.",
    "The allegation of skipping a step is not justified.", "A false claim of missing justification.",
    "An unfounded accusation of circular reasoning.", "A baseless criticism of using a forbidden method.",
    "The claim of missing justification, however, is false.",
    ...["错误的", "有误", "不正确", "不实", "失实", "虚假", "站不住脚", "无稽之谈", "毫无根据", "不成立"].map(
      word => `关于缺少理由的断言完全是${word}。`,
    ),
    "关于缺少理由的说法是错误的。", "错误地指责论证跳步。", "错误地认为论证缺少理由。",
    "错误地认为在第二遍讨论过后重新呈现的完整论证缺少理由。",
  ])("5. treats the denied critique as unverified in %s", feedback => {
    expectOutcome("incorrect", incorrectEquality(identity), "unverified", { feedback });
  });

  it("5. preserves an affirmed critique when the negative predicate itself is negated", () => {
    expectOutcome("incorrect", incorrectEquality(identity), "incorrect", {
      feedback: "The claim of missing justification is not false.",
    });
  });

  it.each([
    ", but every subsequent line skips a necessary step.", ", yet each line skips a necessary step.",
    ", whereas all steps lack justification.", ", while some steps lack justification.",
    ", though another line skips a necessary step.", ", although the derivation lacks justification.",
    ", however, both arguments lack justification.", " but step two skips a necessary step.",
    " yet reasoning lacks justification.", " whereas here you skip a necessary step.",
  ])("6. preserves an independent critique after an indirect question in %s", critique => {
    expectOutcome("incorrect", incorrectEquality(identity), "incorrect", { feedback: "Check whether the expansion is valid" + critique });
  });

  it.each([4, 8, 16])("7. retains at most one span per step for %s overlapping prose and math candidates", count => {
    const proseClaims = Array.from({ length: count }, (_, index) => "word ".repeat(index + 1).trim());
    const mathClaims = Array.from({ length: count }, (_, index) => "x+".repeat(index + 1) + "1=0");
    const steps = sequence(...proseClaims, ...mathClaims).steps;
    const transcription = ("word ".repeat(count * 2) + ". ").repeat(count) +
      mathClaims.map(claim => `Work over F₂. $${claim}$. `).join("").repeat(count);
    const originalPush = Array.prototype.push;
    const originalSet = Map.prototype.set;
    const originalCodePointAt = String.prototype.codePointAt;
    let spans = 0;
    let boundaryReads = 0;
    function countSpan(value: unknown) {
      if (value && typeof value === "object" && "start" in value && "end" in value) spans++;
    }
    Array.prototype.push = function (this: unknown[], ...values: unknown[]) {
      for (const value of values) countSpan(value);
      return Reflect.apply(originalPush, this, values) as number;
    };
    Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      countSpan(value);
      return Reflect.apply(originalSet, this, [key, value]) as Map<unknown, unknown>;
    };
    String.prototype.codePointAt = function (this: string, index: number) {
      if (this === transcription) boundaryReads++;
      return Reflect.apply(originalCodePointAt, this, [index]) as number | undefined;
    };
    let usesReal: ReadonlyMap<(typeof steps)[number], boolean>;
    try {
      usesReal = proofStepUsesRealScalar(steps, transcription, []);
    } finally {
      Array.prototype.push = originalPush;
      Map.prototype.set = originalSet;
      String.prototype.codePointAt = originalCodePointAt;
    }
    expect(steps.map(step => usesReal.get(step))).toEqual([...proseClaims.map(() => true), ...mathClaims.map(() => false)]);
    expect(spans).toBe(steps.length);
    const inputSize = transcription.length + steps.reduce((length, step) => length + step.claim.length, 0);
    expect(boundaryReads).toBeGreaterThan(0);
    expect(boundaryReads).toBeLessThanOrEqual(8 * inputSize);
  });

  it("7. skips overlapping suffixes whose ends always land inside a word", () => {
    const claims = Array.from({ length: 16 }, (_, index) => "a".repeat(2 * index + 1));
    const steps = sequence(...claims).steps;
    const transcription = "aa ".repeat(3950);
    const originalCodePointAt = String.prototype.codePointAt;
    let boundaryReads = 0;
    String.prototype.codePointAt = function (this: string, index: number) {
      if (this === transcription) boundaryReads++;
      return Reflect.apply(originalCodePointAt, this, [index]) as number | undefined;
    };
    let usesReal: ReadonlyMap<(typeof steps)[number], boolean>;
    try {
      usesReal = proofStepUsesRealScalar(steps, transcription, []);
    } finally {
      String.prototype.codePointAt = originalCodePointAt;
    }
    expect(steps.every(step => usesReal.get(step))).toBe(true);
    expect(boundaryReads).toBeLessThanOrEqual(8 * (transcription.length + claims.join("").length));
  });
});

describe("symbolic proof feedback Round 16", () => {
  const identity = "(x+1)^2=x^2+2x+1";

  it.each([
    "The claim that the assumption is false still needs proof.",
    "The assertion that the hypothesis is false awaits further verification.",
    "It remains to be shown that the assumption is false.",
    "The conclusion that this gives a contradiction has not yet been justified.",
    "The contention that the assumption is false.",
    "原假设不成立的说法仍待证明。",
    "还需进一步证明原假设不成立。",
    "原假设不成立这一主张缺少依据。",
    "推出矛盾这一结论尚未得到验证。",
    "The instructor wrote “this gives a contradiction” on the board as an example of wording.",
    'The handout says "this is impossible".',
    "The instructor repeated 'the assumption is false'.",
    "The worksheet quotes ‘this gives a contradiction’.",
    "教材将「推出矛盾」作为表述示例。",
    "课本写着『原假设不成立』。",
    "黑板上的《矛盾》是标题。",
    "As an illustration, this gives a contradiction.",
    "作为措辞示例，这里推出矛盾。",
  ])("keeps the supposition open in %s", feedback => {
    expectOutcome("correct", sequence("Assume x=0.", "1=0", feedback), "unverified");
  });

  it.each([
    "The contradiction shows that the assumption is false.",
    "The claim that the assumption is false follows from $1=0$.",
    "The result doesn't hold. This gives a contradiction.",
    "由此推出矛盾，故原假设不成立。",
    "讲义引用『归谬』；由此推出矛盾。",
  ])("recognizes a proved rejection or contradiction in %s", feedback => {
    expectOutcome("correct", sequence("Assume x=0.", "1=0", feedback), "correct");
  });

  it.each([
    ["Work over ℝ. 1+1=0, and the following step uses F₂.", "unverified"],
    ["Work over ℝ. 1+1=0, the second calculation takes place in F₂.", "unverified"],
    ["Work over ℝ. 1+1=0, and step 2 uses F₂.", "unverified"],
    ["在 ℝ 上计算。1+1=0，下一步使用 F₂。", "unverified"],
    ["1+1=0, because we are working in F₂.", "correct"],
    ["1+1=0, since this is computed over F₂.", "correct"],
    ["1+1=0，因为我们在 F₂ 中运算。", "correct"],
    ["1+1=0, because the next line works in F₂.", "unverified"],
    ["Work over ℝ. One plus one equals zero. After this step, switch to F₂.", "unverified"],
    ["Over ℝ. One plus one equals zero. We work in F₂.", "unverified"],
    ["Over F₂. One plus one equals zero. We work over ℝ.", "unverified"],
    ["在 ℝ 上运算。一加一等于零。此步完成后改用 F₂。", "unverified"],
    ["Working in F₂, one plus one equals zero.", "correct"],
    ["在 F₂ 中运算，一加一等于零。", "correct"],
    ["Work over F₂. 1+1=0! in F₂. Now work over ℝ. 1+1=0.", "unverified"],
    ["Work over F₂. 1+1=0!! in F₂. Now work over ℝ. 1+1=0.", "unverified"],
    ["在 F₂ 上计算。1+1=0! 在 F₂ 中。然后在 ℝ 上计算。1+1=0。", "unverified"],
    ["Work over F₂. 1+1=0 xy. Now work over ℝ. 1+1=0.", "unverified"],
    ["Work over F₂. 1+1=0 cos x. Now work over ℝ. 1+1=0.", "unverified"],
    ["Work over F₂: 1+1=0! Now work over ℝ.", "correct"],
    ["Work over F₂. 1+1=0 holds. Now work over ℝ.", "correct"],
    ["Work over F₂. 1+1=0 mod 2. Now work over ℝ.", "correct"],
  ] as const)("grades the current domain in %s", (transcription, expected) => {
    expectOutcome("correct", sequence("1+1=0"), expected, { transcription });
  });

  it.each(["3=1.", "Three equals one."])("applies a relative transition to the subsequent step in %s", next => {
    const steps = sequence("1+1=0", "3=1").steps;
    const transcription = "Work over ℝ. 1+1=0. After this step, work over F₂. " + next;
    const usesReal = proofStepUsesRealScalar(steps, transcription, []);
    expect(steps.map(step => usesReal.get(step))).toEqual([true, false]);
  });

  it.each([
    ["It is false that the proof lacks justification.", "unverified"],
    ["It is false that the proof lacks justification and skips a necessary step.", "unverified"],
    ["It is simply not accurate to say that the proof skips a necessary step.", "unverified"],
    ["We cannot fairly claim that the proof skips a necessary step.", "unverified"],
    ["There is no basis in saying the proof skips a necessary step.", "unverified"],
    ["说论证缺少理由是不准确的。", "unverified"],
    ["不能认为论证缺少理由。", "unverified"],
    ["Check whether the expansion is valid, but your proof skips a necessary step.", "incorrect"],
    ["Check whether the expansion is valid, and their proof skips a necessary step.", "incorrect"],
    ["Check whether the expansion is valid but overall reasoning lacks justification.", "incorrect"],
    ["请检查展开是否成立，但你的证明缺少理由。", "incorrect"],
    ["请检查展开是否成立但学生的证明缺少理由。", "incorrect"],
    ["The proof skips a necessary step.", "incorrect"],
    ["你的证明缺少理由。", "incorrect"],
    ["It is false that the proof lacks justification, but your proof skips a necessary step.", "incorrect"],
    ["Check whether your proof skips a necessary step.", "unverified"],
  ] as const)("isolates asserted critiques in %s", (feedback, expected) => {
    expectOutcome("incorrect", incorrectEquality(identity), expected, { feedback });
  });

  it.each([16, 48])("bounds terminal indexing for %s overlapping candidates", count => {
    const steps = sequence(...Array.from({ length: count }, (_, index) => "a".repeat(index + 1))).steps;
    const originalSet = Map.prototype.set;
    let numericKeys = 0;
    Map.prototype.set = function (key: unknown, value: unknown) {
      if (typeof key === "number") numericKeys++;
      return Reflect.apply(originalSet, this, [key, value]) as Map<unknown, unknown>;
    };
    let usesReal: ReadonlyMap<(typeof steps)[number], boolean>;
    try {
      usesReal = proofStepUsesRealScalar(steps, "b".repeat(12000), []);
    } finally {
      Map.prototype.set = originalSet;
    }
    expect(steps.map(step => usesReal.get(step))).toEqual(Array(count).fill(true));
    expect(numericKeys).toBeLessThanOrEqual(count);
  });
});

describe("symbolic proof feedback", () => {
  it.each([
    "$1+1=0$.", "$$1+1=0$$.", "1+1=0。", "1+1=0.", "x+1=x+2;", "Step 1: $1=0$；：",
  ])("vetoes a false equation followed by prose punctuation: %s", claim => {
    expect(verifyStandaloneProofEquationClaim(claim).status).toBe("inequivalent");
    expect(adjudicate("correct", proof(claim, "correct"))).toBe("unverified");
  });

  it.each(["$1+1=0.$", "$$1+1=0。$$", "1. +3=3", "1+1=0..", "2=3!", "$1=0."])(
    "keeps ambiguous math punctuation intact: %s", claim => {
      expect(verifyStandaloneProofEquationClaim(claim).status).toBe("unverified");
    },
  );

  it.each([
    ["Work first over F₂. Now switch to ℝ.", "unverified"],
    ["Work over F₂ without division.", "correct"],
    ["Work over ℝ without using F₂.", "unverified"],
    ["Not over F₂, work over ℝ.", "unverified"],
    ["Work over ℝ instead of F₂.", "unverified"],
    ["Work over ℝ, GF(2) is ruled out.", "unverified"],
    ["Work over ℝ, avoid the field F₂.", "unverified"],
    ["Work over ℝ, avoid the finite field F₂.", "unverified"],
    ["Work over ℝ, the finite field F₂ is excluded.", "unverified"],
    ["Work over F₂ but characteristic zero is excluded.", "correct"],
    ["Work over F₂. Now char(K) = 0.", "correct"],
    ["Work over F₂. Now work over ℝ instead of ℂ.", "unverified"],
    ["先在 F₂ 上运算，而后切换到实数域，有限域除外。", "unverified"],
  ])("tracks positive domain selections in %s", (domain, expected) => {
    expect(adjudicate("correct", proof("1+1=0", "correct"), { feedback: domain })).toBe(expected);
  });

  it("applies proposal context and sorted step domains without revising earlier verdicts", () => {
    const feedback = proof("1+1=0", "correct");
    const step = feedback.steps[0]!;
    feedback.steps.unshift({ ...step, stepIndex: 3, claim: "1=0" },
      { ...step, stepIndex: 2, required: false, claim: "Now switch to ℝ." });
    const context = { transcription: "Work over ℝ.", feedback: "Switch to F₂." };
    expect(adjudicate("correct", feedback, context)).toBe("unverified");
    feedback.steps[0]!.required = false;
    expect(adjudicate("correct", feedback, context)).toBe("correct");
    expect(adjudicate("correct", feedback)).toBe("unverified");
  });

  it.each([
    "A contradiction has yet to be established.", "Have we obtained a contradiction?",
    "First check whether this yields a contradiction.", "The contradiction remains unestablished.",
    "Before we derive a contradiction, check this.", "This is far from a contradiction.", "能否推出矛盾？", "矛盾有待推出。",
  ])("keeps an assumption open after pending or interrogative feedback: %s", comment => {
    const feedback = proof("Assume x is positive.", "correct");
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, claim: "1=0", feedback: comment });
    expect(adjudicate("correct", feedback)).toBe("unverified");
  });

  it("still recognizes a completed contradiction after a separate question", () => {
    const feedback = proof("Assume x is positive.", "correct");
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, claim: "1=0",
      feedback: "Have we obtained a contradiction? This is a contradiction." });
    expect(adjudicate("correct", feedback)).toBe("correct");
  });

  it("annotates an open supposition without opening a duplicate frame", () => {
    const feedback = proof("Assume x+1=x.", "correct");
    feedback.steps.push(...["We seek a contradiction.", "1=0", "Reject the assumption.", "2=3",
      "The assumption is false."].map((claim, index) => ({ ...feedback.steps[0]!, stepIndex: index + 2, claim })));
    expect(adjudicate("correct", feedback)).toBe("unverified");
  });

  it.each(["Reject the outer assumption.", "The outer assumption is false."])(
    "uses the immediate explicit rejection to close only the derived inner contradiction before %s", rejection => {
      const feedback = proof("Assume x+1=x.", "correct");
      const step = feedback.steps[0]!;
      feedback.steps.push({ ...step, stepIndex: 2, claim: "Assume y+1=y." },
        { ...step, stepIndex: 3, claim: "1=0", feedback: "This is a contradiction." },
        { ...step, stepIndex: 4, claim: "Reject the inner assumption." },
        { ...step, stepIndex: 5, claim: "1=0" });
      expect(adjudicate("correct", feedback)).toBe("unverified");
      feedback.steps.push({ ...step, stepIndex: 6, claim: rejection });
      expect(adjudicate("correct", feedback)).toBe("correct");
    },
  );

  it.each([
    ["(x+1)^2=x^2+2x+1", "You assumed x is not equal to zero without justification.", "incorrect"],
    ["2+2=4", "The left side ≠ the right side.", "unverified"],
    ["2+2=4", "2+2 is not equal to 4.", "unverified"],
    ["2+2=4", "2+2 does not equal 4.", "unverified"],
    ["$2+2=4$.", "等号左边不等于等号右边。", "unverified"],
    ["2+2=4", "Both sides of the equation are not equal.", "unverified"],
    ["2+2=4", "左侧条件 x 不等于零。", "incorrect"],
    ["1+0=1", "The lhs is not equal to one.", "unverified"],
    ["2+2=4", "The left side ≠ 3.", "incorrect"],
  ])("attributes inequality operands on %s in %s", (claim, comment, expected) => {
    expect(adjudicate("incorrect", incorrectEquality(claim, comment))).toBe(expected);
  });

  it.each([
    ["The equality only holds when x=0.", "unverified"],
    ["The equality holds only when x=0.", "unverified"],
    ["It only holds when x=0.", "unverified"],
    ["The equation fails outside x=0.", "unverified"],
    ["The identity does not hold for all x.", "unverified"],
    ["The reasoning fails when x=0 because you divide by x.", "incorrect"],
    ["The derivation is flawed. It holds only when x=0.", "incorrect"],
    ["The proof does not hold for all x.", "incorrect"],
  ])("attributes restrictions in %s", (comment, expected) => {
    expect(adjudicate("incorrect", incorrectEquality("(x+1)^2=x^2+2x+1", comment))).toBe(expected);
  });

  it.each([
    ["Circular reasoning.", "The equality is incorrect."],
    ["The equality is incorrect.", "Begs the question."],
    ["The equality is incorrect, but the argument uses a forbidden method.", "Recheck it."],
    ["The equality is incorrect. You divide by x without proving it is nonzero.", "Recheck it."],
    ["The equality is incorrect. Division by zero.", "Recheck it."],
  ])("retains a verdict with independent inference evidence in %s or %s", (comment, repairPrompt) => {
    const feedback = incorrectEquality("(x+1)^2=x^2+2x+1", comment);
    feedback.steps[0]!.repairPrompt = repairPrompt;
    expect(adjudicate("incorrect", feedback)).toBe("incorrect");
  });

  it("keeps an incorrect criterion with an independent critique in a separate clause", () => {
    const feedback = proof("(x+1)^2=x^2+2x+1", "incorrect");
    expect(adjudicate("incorrect", feedback, { criteria: [{ label: "Method", verdict: "incorrect",
      feedback: "The equality is incorrect. Circular reasoning." }] })).toBe("incorrect");
  });

  it("does not treat a justified division as an independent inference critique", () => {
    const feedback = incorrectEquality("(x+1)^2=x^2+2x+1");
    feedback.steps[0]!.repairPrompt = "You correctly divide by x after establishing it is nonzero.";
    expect(adjudicate("incorrect", feedback)).toBe("unverified");
  });

  it.each([
    "We have not established a contradiction.", "We failed to produce a contradiction.",
    "We can’t demonstrate any contradiction.", "The contradiction that we expected never appeared.",
    "尚未通过上一步来推出矛盾。", "Neither statement yields an actual contradiction.",
  ])("rejects a false calculation under a supposition when the claimed discharge is negated: %s", comment => {
    const feedback = proof("Assume x is positive.", "correct");
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, claim: "1=0", feedback: comment });
    const proposal = gradingProposal("correct", feedback);
    expect(acceptedAiGradingOutcome(proposal)).toBe("unverified");
    const observed = { ...observation, observationId: "observation-1", outcome: "correct" as const };
    const evaluation: AiEvaluation = {
      ...proposal, observationId: observed.observationId, attemptId: observed.attemptId!,
      problemId: observed.problemId!, itemVersionId: observed.itemVersionId!,
      requirementKey: observed.requirementKey!, evaluatorVersion: "ai-rubric-v1", modelLabel: null,
      evaluatedAt: "2026-10-21T08:00:00Z",
    };
    const reasons = new Set<EvidenceEligibilityReasonCode>();
    expect(evaluateAiCorrectness(observed, evaluation, reasons)).toBe("unknown");
    expect(reasons).toContain("ai_evaluation_criteria_inconsistent");
    expect(reasons).not.toContain("ai_graded_correct");
  });

  it.each([
    ["Work over the real numbers, not over F₂.", "unverified"],
    ["Work over ℝ rather than F₂.", "unverified"],
    ["Work over F₂ rather than F₃.", "correct"],
    ["Work over ℝ, unlike in ℤ/2ℤ.", "unverified"],
    ["Work over ℝ (F₂ is excluded).", "unverified"],
    ["Work over ℝ, not over GF(2).", "unverified"],
    ["Work over ℝ, not where char(K) != 0.", "unverified"],
    ["使用实数域，而不是在有限域。", "unverified"],
    ["The field K satisfies char(K) = 2.", "correct"],
    ["The field has characteristic two.", "correct"],
    ["char(K) = 0", "unverified"],
    ["characteristic zero", "unverified"],
    ["特征为零", "unverified"],
    ["特征(K)是质数", "correct"],
    ["特征(K)不等于零", "correct"],
    ["Work not over ℝ.", "correct"],
    ["Work in a field other than ℝ.", "correct"],
    ["Work in characteristic other than zero.", "correct"],
    ["Work in a field with characteristic of K equal to two.", "correct"],
    ["The characteristic of K is positive.", "correct"],
    ["The characteristic is not zero.", "correct"],
    ["The product is not real.", "unverified"],
    ["char(K) ≠ 0", "correct"],
    ["char(K) != 0", "correct"],
    ["char(K) > 0", "correct"],
    [String.raw`$\operatorname{char}(K) \ne 0$`, "correct"],
    ["Work over ℝ, but now switch to GF(2).", "correct"],
  ])("uses the asserted scalar domain in %s", (domain, expected) => {
    expect(adjudicate("correct", proof("1+1=0", "correct"), { feedback: domain })).toBe(expected);
  });

  it.each(["We seek a contradiction.", "We hope to reach a contradiction.", "This is a contradiction."])(
    "keeps the opening supposition active when its feedback says %s", comment => {
      const feedback = proof("Assume x+1=x.", "correct");
      const first = { ...feedback.steps[0]!, feedback: comment };
      feedback.steps = [first,
        { ...first, stepIndex: 2, claim: "1=0", feedback: "Subtract x." },
        { ...first, stepIndex: 3, claim: "Reject the assumption.", feedback: "Done." }];
      expect(adjudicate("correct", feedback)).toBe("correct");
      feedback.steps.pop();
      expect(adjudicate("correct", feedback)).toBe("unverified");
    },
  );

  it("discharges the inner supposition and retains the outer scope until its own discharge", () => {
    const feedback = proof("Assume x+1=x.", "correct");
    const step = feedback.steps[0]!;
    feedback.steps.push({ ...step, stepIndex: 2, claim: "Suppose y=0." },
      { ...step, stepIndex: 3, claim: "Reject the inner assumption." },
      { ...step, stepIndex: 4, claim: "1=0" },
      { ...step, stepIndex: 5, claim: "Reject the outer assumption." });
    expect(adjudicate("correct", feedback)).toBe("correct");
    feedback.steps.pop();
    expect(adjudicate("correct", feedback)).toBe("unverified");
  });

  it("honors a self-contained discharge stated in the claim", () => {
    const feedback = proof("Assume x+1=x. This is a contradiction.", "correct");
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, claim: "1=0" });
    expect(adjudicate("correct", feedback)).toBe("unverified");
  });

  it.each([
    ["You assumed x ≠ 0 without justification.", "incorrect"],
    ["You assumed x != 0 without justification.", "incorrect"],
    [String.raw`You assumed $x \neq 0$ without justification.`, "incorrect"],
    ["The left side ≠ the right side.", "unverified"],
    ["(x+1)^2 ≠ x^2+2x+1", "unverified"],
    ["The calculation says 2+2 != 4.", "unverified"],
    [String.raw`The calculation says $2+2 \ne 4$.`, "unverified"],
    [String.raw`The calculation says $2+2$ \neq $4$.`, "unverified"],
    ["The equality holds only when x = 0.", "unverified"],
    ["The expression is valid solely for x = 0.", "unverified"],
    ["It holds except when x = 0.", "unverified"],
    ["The equation is true unless x = 0.", "unverified"],
    ["The equality does not hold for all x.", "unverified"],
    ["The equation is true but fails outside this interval.", "unverified"],
    ["等式成立，但仅当 x=0 时成立。", "unverified"],
    ["这并非恒等式。", "unverified"],
  ])("reconciles equality and justification feedback in %s", (comment, expected) => {
    expect(adjudicate("incorrect", incorrectEquality("(x+1)^2=x^2+2x+1", comment))).toBe(expected);
  });

  it("retains an independent inference error when another step has an arithmetic dispute", () => {
    const dispute = "The calculation is incorrect.";
    const feedback = incorrectEquality("2+2=4", dispute);
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, claim: "(x+1)^2=x^2+2x+1",
      feedback: "You assumed the identity you were asked to prove." });
    const math = { label: "Calculation", verdict: "incorrect" as const, feedback: dispute };
    const inference = { label: "Method", verdict: "incorrect" as const, feedback: "Circular reasoning." };
    expect(adjudicate("incorrect", feedback, { criteria: [math, inference] })).toBe("incorrect");
    expect(adjudicate("incorrect", feedback, { criteria: [math] })).toBe("incorrect");
    feedback.steps[1]!.feedback = "Check the step.";
    feedback.steps[1]!.repairPrompt = "Supply the missing intermediate steps.";
    expect(adjudicate("incorrect", feedback, { criteria: [math] })).toBe("incorrect");
    feedback.steps[1]!.repairPrompt = "Check the step.";
    expect(adjudicate("incorrect", feedback, { criteria: [math] })).toBe("unverified");
  });

  it("requires a single-step proposal dispute to be unambiguous", () => {
    const feedback = proof("2+2=4", "incorrect");
    const dispute = "The calculation is incorrect.";
    const math = { label: "Calculation", verdict: "incorrect" as const, feedback: dispute };
    const inference = { label: "Method", verdict: "incorrect" as const, feedback: "Missing justification." };
    expect(adjudicate("incorrect", feedback, { feedback: dispute, criteria: [inference] })).toBe("incorrect");
    expect(adjudicate("incorrect", feedback, { feedback: inference.feedback, criteria: [math] })).toBe("incorrect");
    expect(adjudicate("incorrect", feedback, { feedback: dispute, criteria: [math] })).toBe("unverified");
  });

  it.each([
    String.raw`$\frac{d}{dx}(\sqrt{x})=2=3$`,
    String.raw`$\int \sqrt{x}\,dx=2=3$`,
    String.raw`$\int \sqrt{x}\,dx=x+C=x+C+1$`,
    String.raw`$\int \sqrt{x}\,dx=2=2+C=3$`,
  ])("vetoes an impossible RHS chain even when the calculus target abstains: %s", claim => {
    expect(verifyStandaloneProofEquationClaim(claim)).toEqual({ status: "inequivalent", unconditional: false });
    expect(adjudicate("correct", proof(claim, "correct"))).toBe("unverified");
  });

  it.each([
    String.raw`$\frac{d}{dx}(\sqrt{x})=2=x+1$`,
    String.raw`$\frac{d}{dx}(\sqrt{y})=2=3$`,
    String.raw`$\frac{d}{dx}(\sqrt{x+y})=2=3$`,
    String.raw`$\frac{d}{dx}(\sqrt x)=2=3$`,
    String.raw`$\int \sqrt{C}\,dC=2=3$`,
    String.raw`$\int \sqrt{x}\,dx=x+C=x+2C$`,
  ])("abstains on a potentially consistent RHS or invalid calculus header: %s", claim => {
    expect(verifyStandaloneProofEquationClaim(claim)).toEqual({ status: "unverified", unconditional: false });
  });

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

  it.each([
    "x cannot be zero.", "x can't be zero.", String.raw`x \neq 0`, String.raw`x \ne 0`, "x != 0", "x ≠ 0",
    "The alternative is false.", "That calculation is invalid.", "The condition fails.", "No solutions.",
    "That value does not exist.", "This is not a contradiction.", "There is no contradiction.",
    "Proceed without contradiction.", "这里无矛盾。", "这并不矛盾。", "This does not contradict the assumption.",
  ])("does not let incidental feedback exempt a false calculation: %s", comment => {
    const feedback = proof("Assume x is positive.", "correct");
    feedback.steps[0]!.feedback = comment;
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, claim: "1=0" });
    expect(adjudicate("correct", feedback)).toBe("unverified");
  });

  it.each(["not a contradiction", "no contradiction", "without contradiction", "无矛盾", "不矛盾",
    "We have not reached a contradiction.", "A contradiction has not been derived."])(
    "does not treat a negated counterfactual role as discharge: %s", comment => {
      const feedback = proof("Assume x is positive.", "correct");
      feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, claim: "1=0", feedback: comment });
      expect(adjudicate("correct", feedback)).toBe("unverified");
    },
  );

  it.each([false, true])("ends the contradiction scope at the first discharge (reversed input: %s)", reverse => {
    const feedback = proof("Assume x+1=x.", "correct");
    const step = feedback.steps[0]!;
    feedback.steps.push({ ...step, stepIndex: 2, claim: "1=0" },
      { ...step, stepIndex: 3, claim: "Reject the assumption." },
      { ...step, stepIndex: 4, claim: "2=3" },
      { ...step, stepIndex: 5, claim: "The assumption is false." });
    if (reverse) feedback.steps.reverse();
    expect(adjudicate("correct", feedback)).toBe("unverified");
    feedback.steps = feedback.steps.filter(({ stepIndex }) => stepIndex !== 4);
    expect(adjudicate("correct", feedback)).toBe("correct");
  });

  it("does not discharge a supposition when a contradiction is the goal", () => {
    const feedback = proof("To derive a contradiction, assume x+1=x.", "correct");
    const step = feedback.steps[0]!;
    feedback.steps.push({ ...step, stepIndex: 2, claim: "1=0", feedback: "Subtract x." },
      { ...step, stepIndex: 3, claim: "Reject the assumption." });
    expect(adjudicate("correct", feedback)).toBe("correct");
  });

  it("does not open a supposition when the feedback says to avoid assuming the conclusion", () => {
    const feedback = proof("1=0", "correct");
    const step = feedback.steps[0]!;
    step.feedback = "Do not assume the conclusion.";
    feedback.steps.push({ ...step, stepIndex: 2, claim: "This is the derived contradiction." });
    expect(adjudicate("correct", feedback)).toBe("unverified");
  });

  it("permits a new contradiction argument after an earlier discharge", () => {
    const feedback = proof("If x+1=x, subtract x.", "correct");
    const step = feedback.steps[0]!;
    feedback.steps = [
      { ...step, stepIndex: 6, claim: "The hypothesis is impossible." },
      { ...step, stepIndex: 3, claim: "1=0", feedback: "This is the derived contradiction." },
      step,
      { ...step, stepIndex: 5, claim: "2=3" },
      { ...step, stepIndex: 4, claim: "Suppose y+2=y+3." },
      { ...step, stepIndex: 2, claim: "x+1=x", feedback: "Use the supposition." },
    ];
    expect(adjudicate("correct", feedback)).toBe("correct");
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

  it.each(["Work in the field F₂", "𝔽₂", "F_2", "\\mathbb{F}_{2}", "GF(2)", "GF(p^n)",
    "ℤ/2ℤ", "Z/2Z", "\\mathbb{Z}/2\\mathbb{Z}", "ℤ/pℤ", "Z/(2)", "ℤ₂", "Z_2", "F_p",
    "modulo 2", "\\pmod{2}", "char 2", "characteristic = p", "特征为 2", "finite field", "p-adic field",
    "fields of fractions", "ℂ", "\\mathbb{H}", "boolean algebra", "有限域", "复数域", "模 2", "matrix algebra", "linear operators"])(
    "does not apply real-scalar verification in context %s", context => {
      const feedback = proof(context, "correct", false);
      feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, required: true, claim: "1+1=0" });
      expect(adjudicate("correct", feedback)).toBe("correct");
    },
  );

  it.each(["field", "fields", "characteristic 0", "char 0", "特征为 0", "field of real numbers",
    "real field", "real number field", "ordered field", "over ℝ", "over \\mathbb{R}", "实数域"])(
    "still checks a false real-scalar calculation in %s", domain => {
      const feedback = proof(`Work in the ${domain}.`, "correct", false);
      feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, required: true, claim: "1=0" });
      expect(adjudicate("correct", feedback)).toBe("unverified");
      expect(adjudicate("correct", proof("1=0", "correct"), { feedback: domain })).toBe("unverified");
    },
  );

  it.each<ProposalContext>([
    { feedback: "The calculation is in F₂." },
    { feedback: "The calculation is in ℤ/2ℤ." },
    { criteria: [{ label: "Result", verdict: "correct", feedback: "Work in ℤ/2ℤ." }] },
    { criteria: [{ label: "Arithmetic in F₂", verdict: "correct", feedback: "The result follows." }] },
    { transcription: "Work in ℤ/2ℤ." },
  ])("uses the proposal-level domain in both grading entry points: %o", context => {
    const proposal = gradingProposal("correct", proof("1+1=0", "correct"), context);
    expect(acceptedAiGradingOutcome(proposal)).toBe("correct");
    const observed = { ...observation, observationId: "observation-1", outcome: "correct" as const };
    const evaluation: AiEvaluation = {
      ...proposal, observationId: observed.observationId, attemptId: observed.attemptId!,
      problemId: observed.problemId!, itemVersionId: observed.itemVersionId!,
      requirementKey: observed.requirementKey!, evaluatorVersion: "ai-rubric-v1", modelLabel: null,
      evaluatedAt: "2026-10-21T08:00:00Z",
    };
    const reasons = new Set<EvidenceEligibilityReasonCode>();
    expect(evaluateAiCorrectness(observed, evaluation, reasons)).toBe("unknown");
    expect(reasons.has("ai_graded_correct")).toBe(true);
  });

  it("uses modular arithmetic feedback only from the current or an earlier step", () => {
    const claim = "sqrt(4) = 2";
    expect(verifyStandaloneProofEquationClaim(claim)).toEqual({ status: "equivalent", unconditional: true });
    const feedback = incorrectEquality(claim);
    feedback.steps.push({ ...feedback.steps[0]!, stepIndex: 2, required: false, claim: "Check the choice of root.",
      feedback: "No principal square root was specified in F₅." });
    expect(proofFeedbackAllowsOutcome("incorrect", feedback)).toBe(false);
    expect(adjudicate("incorrect", feedback)).toBe("unverified");
    feedback.steps[0]!.stepIndex = 3;
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
    expect(adjudicate("incorrect", incorrectEquality(claim))).toBe("unverified");
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
    if (status === "equivalent") expect(adjudicate("incorrect", incorrectEquality(claim))).toBe("unverified");
  });

  it.each([
    "(x+1)^2 = x^2 + 2x + 1",
    String.raw`\frac{d}{dx}(x^3) = 3x^2`,
    String.raw`\int 2x\,dx = x^2 + C`,
  ])("vetoes a negative verdict that disputes an unconditional identity %s", claim => {
    expect(proofFeedbackAllowsOutcome("incorrect", incorrectEquality(claim))).toBe(false);
    expect(adjudicate("incorrect", incorrectEquality(claim))).toBe("unverified");
  });

  it.each([
    "You assumed the identity you were asked to prove.", "Circular reasoning.", "Begs the question.",
    "Restates the conclusion.", "Missing justification.", "Skipped steps.", "The equality does not follow.",
    "Although the equality holds, your reasoning is incorrect.", "The equality is not incorrect.",
    "Although the identity is true, the calculation is wrong as a justification.",
    "You miscalculated nothing, but skipped the proof.", "循环论证。", "未证先用。", "缺少推导。", "跳步。", "等式成立，但缺少推导。",
    "Check the step.",
  ])("retains an incorrect proof verdict when feedback does not dispute the identity: %s", comment => {
    const feedback = incorrectEquality("(x+1)^2=x^2+2x+1", comment);
    expect(adjudicate("incorrect", feedback, { feedback: comment })).toBe("incorrect");
  });

  it.each([
    "The identity is false.", "Your expansion is wrong.", "The derivative does not match.", "The sides are not equal.",
    "Algebraic error.", "Missing constant.", "You miscalculated the result.", "The left side is not equal to the right side.",
    "等式不成立。", "展开错误。", "漏项。",
  ])("vetoes a mathematical dispute in the repair prompt: %s", repairPrompt => {
    const feedback = proof("(x+1)^2=x^2+2x+1", "incorrect");
    feedback.steps[0]!.repairPrompt = repairPrompt;
    expect(adjudicate("incorrect", feedback)).toBe("unverified");
  });

  it("uses proposal feedback and incorrect criteria to identify a mathematical dispute", () => {
    const feedback = proof("(x+1)^2=x^2+2x+1", "incorrect");
    const dispute = "The calculation is incorrect.";
    const method = { label: "Method", verdict: "incorrect" as const, feedback: "Missing justification." };
    expect(adjudicate("incorrect", feedback, { feedback: dispute })).toBe("unverified");
    expect(adjudicate("incorrect", feedback, { criteria: [{ ...method, feedback: dispute }] })).toBe("unverified");
    expect(adjudicate("incorrect", feedback, { criteria: [method, { ...method, verdict: "correct", feedback: dispute }] }))
      .toBe("incorrect");
  });

  it.each(["x/x = 1", "1/(x^2+1) = 1/(1+x^2)", "sqrt(x)^2 = x", "假设 x=1，得 0=1，矛盾",
    "设 Av=λv", "两边同乘非零常数", "If x=1 then x^2=1", "x!=1", "(x+1)^2=x^2+1"])(
    "retains a negative verdict when %s is not an unconditional verified identity", claim => {
      expect(proofFeedbackAllowsOutcome("incorrect", incorrectEquality(claim))).toBe(true);
      expect(adjudicate("incorrect", incorrectEquality(claim))).toBe("incorrect");
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
