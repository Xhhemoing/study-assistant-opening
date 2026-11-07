import { describe, expect, it } from "vitest";
import { checkArithmeticAnswer, corroborateArithmeticGrade } from "./arithmetic-check";

describe("exact arithmetic corroboration", () => {
  it.each([
    ["1/2 + 1/2?", "2/2"], ["计算：1/3 + 1/6", "0.5"],
    ["Evaluate 0.1 + 0.2 = ?", "0.3"], ["计算 2*(3-5)", "-4"],
    ["计算 1/2+1/2", "1/2+1/2=2/2=1"], ["1/3+1/6?", "$\\frac{1}{2}$"],
    ["计算 2÷(-4)", "-0.5"], ["计算 1/2+1/2", "答案：1"],
  ])("accepts equivalent complete arithmetic: %s / %s", (question, answer) => {
    expect(checkArithmeticAnswer(question, answer)).toBe("correct");
  });
  it.each([
    ["1/2+1/2?", "2"], ["1/2+1/2?", "1/2+1/2=2/4=1"],
    ["1/3+1/6?", "0.4999999999999999"], ["2*(3-5)?", "4"],
  ])("detects wrong results and wrong equalities: %s / %s", (question, answer) => {
    expect(checkArithmeticAnswer(question, answer)).toBe("incorrect");
  });
  it.each([
    ["证明 1/2+1/2=1", "1"], ["求 x: x+1=2", "1"], ["计算 1/0", "1"],
    ["计算 1/2+1/2", "因为分母相同所以答案是1"], ["1/2+1/2?", "1 或 2"],
    ["计算 1/3", "约0.33"], ["1米+2厘米?", "1.02"], ["选择正确答案：1+1", "A"],
    ["1", "1"], ["1+1", ""], ["1+1", "process.exit()"],
    ["计算 1 1/2+1/2", "2"], ["1+1", "1 1/2"],
    ["1+1", "(".repeat(30) + "2" + ")".repeat(30)], ["1+1", "9".repeat(1000)],
  ])("does not infer unsupported semantics: %s", (question, answer) => {
    expect(checkArithmeticAnswer(question, answer)).toBeNull();
  });
});

it("keeps uncertain grades uncertain and removes misleading follow-up after disagreement", () => {
  const proposal = { outcome: "incorrect" as const, confidence: 0.99, questionMatch: true,
    feedback: "错了", misconceptionId: "wrong_rule", criteria: [{ label: "相加", verdict: "incorrect" as const, feedback: "错了" }],
    followUp: { prompt: "跟着练", options: [{ id: "a", label: "1" }, { id: "b", label: "2" }], answerId: "b", explanation: "2" } };
  const checked = corroborateArithmeticGrade("1/2+1/2?", "1", proposal);
  expect(checked).toMatchObject({ outcome: "unverified", misconceptionId: null });
  expect(checked.followUp).toBeUndefined();
  expect(proposal.outcome).toBe("incorrect");
  const uncertain = { ...proposal, confidence: 0.2 };
  expect(corroborateArithmeticGrade("1/2+1/2?", "1", uncertain)).toBe(uncertain);
});

it("exports exact question and literal parsers", async () => {
  const { evaluateArithmeticQuestion, parseArithmeticLiteral, equalArithmeticValues } = await import("./arithmetic-check");
  expect(equalArithmeticValues(evaluateArithmeticQuestion("计算 1/4+1/4?")!, parseArithmeticLiteral("2/4")!)).toBe(true);
  expect(evaluateArithmeticQuestion("2")).toBeNull();
  expect(parseArithmeticLiteral("1+1")).toBeNull();
  expect(parseArithmeticLiteral("\\frac{1}{0}")).toBeNull();
});

describe("public exact arithmetic helpers", () => {
  it.each([
    ["计算：1/3+1/6？", { n: 1n, d: 2n }],
    ["Evaluate 0.1+0.2 = ?", { n: 3n, d: 10n }],
    ["求值 2*(3-5)。", { n: -4n, d: 1n }],
    ["calculate 2÷(-4)", { n: -1n, d: 2n }],
    ["计算 2-2", { n: 0n, d: 1n }],
  ])("evaluates supported question text exactly: %s", async (question, expected) => {
    const { evaluateArithmeticQuestion } = await import("./arithmetic-check");
    expect(evaluateArithmeticQuestion(question)).toEqual(expected);
  });

  it.each(["2", "-2", "计算 2", "计算 1/0", "x+1", "1 1/2+1/2", "计算 1米+2米", "π+1"])("rejects unsupported question %s", async question => {
    const { evaluateArithmeticQuestion } = await import("./arithmetic-check");
    expect(evaluateArithmeticQuestion(question)).toBeNull();
  });

  it.each([
    [" -12 ", { n: -12n, d: 1n }], ["-0", { n: 0n, d: 1n }],
    ["14/24", { n: 7n, d: 12n }], ["-14/24", { n: -7n, d: 12n }],
    ["\\frac{14}{24}", { n: 7n, d: 12n }], ["-\\frac{2}{4}", { n: -1n, d: 2n }],
    ["0.50", { n: 1n, d: 2n }], ["-.125", { n: -1n, d: 8n }],
  ])("parses and reduces a single literal %s", async (literal, expected) => {
    const { parseArithmeticLiteral } = await import("./arithmetic-check");
    expect(parseArithmeticLiteral(literal)).toEqual(expected);
  });

  it.each(["", "+1", "--1", "1+1", "(1)", "7 / 12", "7/-12", "1/0", "\\frac{1}{0}", "π", "√2", "1米", "1 2", "1e3"])("rejects nonliteral or undefined value %j", async literal => {
    const { parseArithmeticLiteral } = await import("./arithmetic-check");
    expect(parseArithmeticLiteral(literal)).toBeNull();
  });

  it("compares rational values rather than their representation", async () => {
    const { equalArithmeticValues } = await import("./arithmetic-check");
    expect(equalArithmeticValues({ n: 2n, d: 4n }, { n: 1n, d: 2n })).toBe(true);
    expect(equalArithmeticValues({ n: -2n, d: 4n }, { n: -1n, d: 2n })).toBe(true);
    expect(equalArithmeticValues({ n: 0n, d: 3n }, { n: 0n, d: 1n })).toBe(true);
    expect(equalArithmeticValues({ n: 1n, d: 3n }, { n: 333n, d: 1000n })).toBe(false);
    expect(equalArithmeticValues({ n: -1n, d: 2n }, { n: 1n, d: 2n })).toBe(false);
  });
});
