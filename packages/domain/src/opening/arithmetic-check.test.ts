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
