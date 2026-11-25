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
  ])("keeps the decimal rule for nonterminating exact results from %s", (stem, key) => {
    expect(check(stem, numeric, key, "0.3333")).toBe("unparseable");
    expect(check(stem, numeric, key, "2/6")).toBe("correct");
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
  it("recognizes display math as one span", () => {
    expect(check("Simplify $$x*x$$", choice("$$x*x$$", "x+1"), "A", "A. $$x*x$$")).toBe("correct");
    expect(check("Simplify x\\*x", choice("x\\*x", "x+1"), "A", "A. x\\*x")).toBe("correct");
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
  it.each([
    "(x+1)^2 = x^2 + 1", "Step 1: $$(x+1)^2 = x^2 + 2x + 1 = x^2 + 1$$",
    String.raw`(1) $\frac{d}{dx}(x^3) = x^2$`, String.raw`1. \int 2x\,dx = x^3 + C`,
  ])("vetoes a positive verdict on a refuted required claim %s", claim => {
    expect(proofFeedbackAllowsOutcome("correct", proof(claim, "correct"))).toBe(false);
    expect(adjudicate("correct", proof(claim, "correct"))).toBe("unverified");
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
    feedback.steps.push({ ...proof("(x+1)^2 = x^2 + 1", "correct", false).steps[0]!, stepIndex: 2 });
    expect(adjudicate("correct", feedback)).toBe("correct");
    const claim = "(x+1)^1000 = (x+1)^1000";
    expect(verifyStandaloneProofEquationClaim(claim).status).toBe("unverified");
    expect(adjudicate("incorrect", proof(claim, "incorrect"))).toBe("incorrect");
    expect(check("Simplify $(x+1)^1000$", choice("(x+1)^1000", "1"), "A", "A. (x+1)^1000")).toBeNull();
  });
});

describe("structured symbolic steps", () => {
  it("uses the declared variable and distinguishes invalid from inequivalent steps", () => {
    const derivative = { kind: "derivative" as const, reference: "t^3", variable: "t" };
    expect(verifySymbolicStepEquivalence({ ...derivative, student: "3t^2" })).toBe("equivalent");
    expect(verifySymbolicStepEquivalence({ ...derivative, student: "t^2" })).toBe("inequivalent");
    expect(verifySymbolicStepEquivalence({ ...derivative, student: "1/0" })).toBe("unverified");
  });
});
