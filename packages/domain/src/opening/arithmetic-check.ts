import type { AiGradingProposal } from "@aistudy/contracts";
import { acceptedAiGradingOutcome } from "./ai-evaluation";

/** Exact, deliberately small arithmetic language. Never evaluate JavaScript or infer a word problem. */
type Rational = { n: bigint; d: bigint };
const equal = (a: Rational, b: Rational) => a.n * b.d === b.n * a.d;

function rational(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new RangeError("division by zero");
  let a = n < 0n ? -n : n, b = d < 0n ? -d : d;
  while (b) [a, b] = [b, a % b];
  const divisor = a || 1n, sign = d < 0n ? -1n : 1n;
  return { n: sign * n / divisor, d: sign * d / divisor };
}

function normalize(text: string): string {
  return text.trim().replace(/^\$([^$]*)\$$/, "$1")
    .replace(/\\(?:dfrac|tfrac|frac)\{(-?\d{1,18})\}\{(-?\d{1,18})\}/g, "($1/$2)")
    .replace(/\\times|×|·/g, "*").replace(/\\div|÷/g, "/").replace(/−/g, "-")
    .replace(/\s/g, "");
}

/** Returns null for invalid or unsupported expressions, including units, symbols and approximations. */
function parse(text: string): Rational | null {
  // Whitespace can denote a mixed fraction; deleting it would change 1 1/2 into 11/2.
  if (/[\d.]\s+[\d.]/.test(text)) return null;
  const source = normalize(text);
  if (!source || source.length > 256 || !/^[\d.+\-*/()]+$/.test(source)) return null;
  const tokens = source.match(/\d+(?:\.\d+)?|\.\d+|[+\-*/()]/g) ?? [];
  if (tokens.join("") !== source || tokens.length > 128) return null;
  let position = 0;
  function atom(depth: number): Rational {
    if (depth > 16) throw new RangeError("nesting limit");
    const token = tokens[position++];
    if (token === "+" || token === "-") {
      const value = atom(depth + 1);
      return { ...value, n: token === "-" ? -value.n : value.n };
    }
    if (token === "(") {
      const value = sum(depth + 1);
      if (tokens[position++] !== ")") throw new RangeError("missing parenthesis");
      return value;
    }
    if (!token || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token) || token.replace(".", "").length > 18) {
      throw new RangeError("invalid number");
    }
    const decimals = token.split(".")[1]?.length ?? 0;
    return rational(BigInt(token.replace(".", "")), 10n ** BigInt(decimals));
  }
  function product(depth: number): Rational {
    let value = atom(depth);
    while (tokens[position] === "*" || tokens[position] === "/") {
      const operator = tokens[position++], right = atom(depth);
      value = operator === "*" ? rational(value.n * right.n, value.d * right.d)
        : rational(value.n * right.d, value.d * right.n);
    }
    return value;
  }
  function sum(depth: number): Rational {
    let value = product(depth);
    while (tokens[position] === "+" || tokens[position] === "-") {
      const operator = tokens[position++], right = product(depth);
      value = rational(value.n * right.d + (operator === "+" ? 1n : -1n) * right.n * value.d, value.d * right.d);
    }
    return value;
  }
  try {
    const value = sum(0);
    return position === tokens.length ? value : null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** A corroboration of a full arithmetic answer, never authority for proofs, photos or general mathematics. */
export function checkArithmeticAnswer(question: string, answer: string): "correct" | "incorrect" | null {
  if (question.length > 400 || answer.length > 1200) return null;
  const expression = question.trim().replace(/^(?:计算|求值|calculate|evaluate)\s*[:：]?\s*/i, "")
    .replace(/\s*(?:=\s*[?？]?|[?？。])\s*$/, "");
  const expected = parse(expression);
  // A bare number is not sufficient to identify the question's requested operation.
  if (!expected || !/[+*/]|\d\s*[-−]|\\(?:frac|times|div)|[×÷]/.test(expression)) return null;
  const steps = answer.trim().replace(/^(?:答案|答|answer)\s*[:：]\s*/i, "").split("=");
  if (steps.length > 12) return null;
  const values = steps.map(parse);
  if (values.some(value => value === null)) return null;
  return values.every(value => equal(value!, expected)) ? "correct" : "incorrect";
}

/** Model disagreement is uncertainty about grading, not a student's failure or success. */
export function corroborateArithmeticGrade(question: string, answer: string, proposal: AiGradingProposal): AiGradingProposal {
  const checked = checkArithmeticAnswer(question, answer);
  const accepted = acceptedAiGradingOutcome(proposal);
  if (!checked || accepted === "unverified" || checked === accepted) return proposal;
  const { followUp: _followUp, ...original } = proposal;
  return { ...original, outcome: "unverified", misconceptionId: null,
    feedback: "程序验算与 AI 的判断不一致，这次暂不判对错，也不据此安排错题补课。请核对原题、等价写法或中间步骤后手动改评。",
    criteria: [{ label: "有理数运算交叉核对", verdict: "unverified",
      feedback: "算式或等式步骤的精确验算与批改结论冲突，需要复核。" }] };
}
