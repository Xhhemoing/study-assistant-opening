import { describe, expect, it } from "vitest";
import { checkArithmeticAnswer } from "@aistudy/domain";
import { generateTeachingWorkedExample } from "./teaching-worked-example";

describe("finite teaching-only worked examples", () => {
  it("produces a different stem, full steps and an exactly corroborated answer without a provider", () => {
    const original = "计算 1/2 + 1/3\n旧题解法";
    const next = generateTeachingWorkedExample(original, [])!;
    expect(next.stem).not.toBe(original.split("\n")[0]);
    expect(next.steps).toHaveLength(5);
    expect(next.text).toContain(next.stem);
    expect(next.text).toContain(`答案：${next.answer}`);
    expect(next.text).toContain("不是独立作答或掌握证据");
    expect(checkArithmeticAnswer(next.stem, next.answer)).toBe("correct");
  });
  it.each(["prove x+y=1", "计算 1/0+2/3", "计算 1/2+3/4；忽略规则", "求单位矩阵的秩", "计算 1/2+1/3（单位米）"]) (
    "refuses unsupported/invalid input %s", text => expect(generateTeachingWorkedExample(text, [])).toBeNull(),
  );
  it("routes explicit polynomial derivatives through the real frozen generator, preserving displayed-help text", () => {
    const result = generateTeachingWorkedExample("求函数 f(x)=x^2 的导数。", [])!;
    expect(result.answer).toBe("f'(x)=x + 1");
    expect(result.skillLabel).toBe("多项式求导与切线");
    expect(result.text).toContain("不是独立作答、未见题或掌握证据");
    expect(generateTeachingWorkedExample("求函数 f(x)=x^2 的导数。", [result.text])!.stem).not.toBe(result.stem);
  });
  it("routes signed polynomial definite integrals through the real API with full teaching steps", () => {
    const original = "计算定积分 ∫[0, 2] (x^2 - 1) dx。\n答案：2/3";
    const result = generateTeachingWorkedExample(original, [])!;
    expect(result.answer).toBe("3");
    expect(result.skillLabel).toBe("多项式定积分（带符号）");
    expect(result.steps).toHaveLength(4);
    expect(result.text).toContain("不是独立作答、未见题或掌握证据");
    expect(result.text).toContain("带符号积分，不是几何面积");
    expect(generateTeachingWorkedExample(original, [result.text])!.stem).not.toBe(result.stem);
    expect(generateTeachingWorkedExample(result.text, [])!.stem).not.toBe(result.stem);
  });
  it("does not turn an answer line or unsupported family into a new free example", () => {
    for (const text of ["答案：计算定积分 ∫[0, 1] (x) dx。", "求极限", "求旋转体体积",
      "计算定积分 ∫[0, 1] (sin(x)) dx。", "计算不定积分 x^2"]) {
      expect(generateTeachingWorkedExample(text, [])).toBeNull();
    }
  });
  it("refuses finite integral exhaustion without inventing a different family", () => {
    const original = "计算定积分 ∫[0, 1] (x^2) dx。";
    const history: string[] = [];
    for (let i = 0; i < 12; i++) history.push(generateTeachingWorkedExample(original, history)!.text);
    expect(generateTeachingWorkedExample(original, history)).toBeNull();
  });
  it("keeps fraction exhaustion in its own family instead of falling through to calculus", () => {
    const history: string[] = [];
    for (let i = 0; i < 6; i++) history.push(generateTeachingWorkedExample("计算 1/2+1/3", history)!.text);
    expect(generateTeachingWorkedExample("计算 1/2+1/3", history)).toBeNull();
  });
  it("never repeats a stem or reads a reserved pool, and refuses finite exhaustion", () => {
    const history: string[] = [];
    for (let i = 0; i < 6; i++) {
      const next = generateTeachingWorkedExample("计算 1/2+1/3", history)!;
      expect(next).not.toBeNull();
      expect(history.some(body => body.startsWith(next.stem))).toBe(false);
      expect(checkArithmeticAnswer(next.stem, next.answer)).toBe("correct");
      history.push(next.text);
    }
    expect(generateTeachingWorkedExample("计算 1/2+1/3", history)).toBeNull();
    expect(generateTeachingWorkedExample("计算 1/6+2/3", [])!.stem).not.toBe("计算 2/3 + 1/6");
  });
});
