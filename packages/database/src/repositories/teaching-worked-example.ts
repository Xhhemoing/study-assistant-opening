import { checkArithmeticAnswer } from "@aistudy/domain";
import { dispatchCalculusExample } from "../../../domain/src/opening/calculus-example-dispatch";
import { generateCalculusDerivativeExample } from "../../../domain/src/opening/calculus-derivative-examples";
import { generatePolynomialIntegralExample, solvePolynomialIntegralExample } from "../../../domain/src/opening/calculus-integral-examples";

/** Private, finite teaching-only supply. No model output or reserved assessment bank. */
const candidates = [[2, 3, 1, 6], [3, 4, 1, 6], [2, 5, 1, 3], [3, 7, 2, 5], [5, 8, 1, 3], [4, 9, 2, 7]] as const;
const normalize = (text: string) => text.normalize("NFKC").replace(/\s/g, "");

function stem(text: string): string | null {
  // Recognize only an explicit arithmetic first line; never infer operands from prose.
  const first = text.trim().split("\n")[0]!.trim();
  return /^(?:计算\s*[:：]?\s*|calculate\s*[:：]?\s*)?\d{1,3}\/\d{1,3}\s*\+\s*\d{1,3}\/\d{1,3}\s*(?:[?？。]|=\s*[?？]?)?$/i.test(first)
    && checkArithmeticAnswer(first, "0") !== null ? first : null;
}
function operandKey(text: string): string | null {
  const value = stem(text);
  return value ? normalize(value).replace(/^(?:计算[:：]?|calculate[:：]?)/i, "").replace(/[=?？。]+$/, "")
    .split("+").map(operand => {
      const [n, d] = operand.split("/").map(Number) as [number, number];
      let x = n, y = d;
      while (y) [x, y] = [y, x % y];
      return `${n / x}/${d / x}`;
    }).sort().join("+") : null;
}

export type WorkedExampleBody = { text: string; stem: string; answer: string; steps: string[]; skillLabel: string };

/** Reuse the existing free command; unsupported/exhausted families refuse publication. */
export function generateTeachingWorkedExample(original: string, previousBodies: readonly string[]): WorkedExampleBody | null {
  // Keep the original arithmetic family's grammar, checks and history unchanged.
  if (stem(original)) return generateFractionAdditionExample(original, previousBodies);
  return dispatchCalculusExample(original, previousBodies, {
    derivative: generateCalculusDerivativeExample,
    solveIntegral: solvePolynomialIntegralExample,
    integral: generatePolynomialIntegralExample,
  });
}

/** A complete, exactly checked fraction-addition example, or no publication. */
function generateFractionAdditionExample(original: string, previousBodies: readonly string[]): WorkedExampleBody | null {
  const seen = new Set([original, ...previousBodies].map(operandKey).filter(Boolean));
  for (const [a, b, c, d] of candidates) {
    const prompt = `计算 ${a}/${b} + ${c}/${d}`;
    if (seen.has(operandKey(prompt))) continue;
    const denominator = b * d, numerator = a * d + c * b;
    let x = numerator, y = denominator;
    while (y) [x, y] = [y, x % y];
    const answer = `${numerator / x}/${denominator / x}`;
    const equality = `${a}/${b}+${c}/${d}=${a * d}/${denominator}+${c * b}/${denominator}=${numerator}/${denominator}=${answer}`;
    if (checkArithmeticAnswer(prompt, equality) !== "correct") return null;
    const steps = [
      `通分：取公分母 ${b}×${d}=${denominator}；分子、分母同乘相同的非零数，分数值不变。`,
      `${a}/${b}=${a * d}/${denominator}，${c}/${d}=${c * b}/${denominator}。`,
      `同分母相加：分母保持 ${denominator}，分子相加 ${a * d}+${c * b}=${numerator}。`,
      `约分得到 ${answer}。不能把两个分母直接相加。`,
      `验算（精确有理数等式）：${equality}。`,
    ];
    return { stem: prompt, answer, steps, skillLabel: "有理数加法",
      text: `${prompt}\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n答案：${answer}\n这是已展示解法的学习例题，不是独立作答或掌握证据。` };
  }
  return null;
}
