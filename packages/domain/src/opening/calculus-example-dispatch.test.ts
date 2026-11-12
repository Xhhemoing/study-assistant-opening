import { describe, expect, it, vi } from "vitest";
import { generateCalculusDerivativeExample, type CalculusExampleRequest } from "./calculus-derivative-examples";
import { generatePolynomialIntegralExample, solvePolynomialIntegralExample } from "./calculus-integral-examples";
import { dispatchCalculusExample } from "./calculus-example-dispatch";

const generators = {
  derivative: generateCalculusDerivativeExample,
  solveIntegral: solvePolynomialIntegralExample,
  integral: generatePolynomialIntegralExample,
};
const original = "求函数 f(x)=x^2 的导数。\n旧题解法";
const integralOriginal = "计算定积分 ∫[0, 2] (x^2 - 1) dx。\n答案：2/3";
const integralFirst = generatePolynomialIntegralExample({ family: "polynomial-definite", seed: 0, index: 0 });
if (integralFirst.status !== "supported") throw new Error("finite integral fixture unavailable");

describe("free teaching calculus text dispatch", () => {
  it("adapts explicit polynomial derivative text to the frozen typed API", () => {
    const derivative = vi.fn(generateCalculusDerivativeExample);
    const result = dispatchCalculusExample(original, [], { ...generators, derivative })!;
    expect(derivative).toHaveBeenCalledExactlyOnceWith({
      original: { task: "derivative", function: { family: "polynomial", coefficients: [
        { numerator: 0, denominator: 1 }, { numerator: 0, denominator: 1 }, { numerator: 1, denominator: 1 },
      ] } }, previous: [], seed: 0,
    });
    expect(result.stem).not.toBe(original.split("\n")[0]);
    expect(result.answer).toBe("f'(x)=x + 1");
    expect(result.text).toContain("不是独立作答、未见题或掌握证据");
  });

  it("adapts tangent text, signed rational coefficients and a rational tangent point", () => {
    const result = dispatchCalculusExample("求曲线 y=f(x)=-1/2*x^3 + 2*x 在 x=-1/2 处的切线方程。", [], generators)!;
    expect(result.skillLabel).toBe("多项式求导与切线");
    expect(result.answer).toBe("y=-5/2");
  });

  it("adapts the real integral API and emits a complete exact, signed teaching solution", () => {
    const solveIntegral = vi.fn(solvePolynomialIntegralExample);
    const integral = vi.fn(generatePolynomialIntegralExample);
    const derivative = vi.fn(generateCalculusDerivativeExample);
    const next = dispatchCalculusExample(integralOriginal, [], { derivative, solveIntegral, integral })!;
    expect(solveIntegral).toHaveBeenCalledExactlyOnceWith({ family: "polynomial-definite", lower: 0, upper: 2,
      coefficients: [{ numerator: -1, denominator: 1 }, { numerator: 0, denominator: 1 }, { numerator: 1, denominator: 1 }] });
    expect(integral).toHaveBeenCalledExactlyOnceWith({ family: "polynomial-definite", seed: 0, index: 0 });
    expect(derivative).not.toHaveBeenCalled();
    expect(next.stem).toBe(integralFirst.example.prompt);
    expect(next.answer).toBe("3");
    expect(next.steps).toEqual(integralFirst.example.steps);
    expect(next.text).toContain("答案：3");
    expect(next.text).toContain("带符号积分，不是几何面积");
    expect(next.text).toContain("不是独立作答、未见题或掌握证据");
  });

  it.each([original, integralOriginal])("replays with unchanged input and advances only with real history: %s", stem => {
    const first = dispatchCalculusExample(stem, [], generators)!;
    expect(dispatchCalculusExample(stem, [], generators)).toEqual(first);
    expect(dispatchCalculusExample(stem, [first.text], generators)!.stem).not.toBe(first.stem);
  });

  it.each([
    ["求函数 f(x)=x^2 的导数。", 6],
    ["求曲线 y=f(x)=x^2 在 x=1 处的切线方程。", 6],
    [integralOriginal, 12],
  ] as const)("never repeats finite bodies, then refuses exhaustion: %s", (stem, capacity) => {
    const history: string[] = [];
    for (let i = 0; i < capacity; i++) {
      const next = dispatchCalculusExample(stem, history, generators)!;
      expect(next).not.toBeNull();
      expect(history.some(body => body.startsWith(next.stem))).toBe(false);
      history.push(next.text);
    }
    expect(dispatchCalculusExample(stem, history, generators)).toBeNull();
  });

  it("skips equivalent integral originals and history using the solver's mathematical identity", () => {
    const equivalent = "计算定积分 ∫[-2, 1] (2/2) dx。";
    const first = dispatchCalculusExample(equivalent, [], generators)!;
    expect(first.stem).not.toBe(integralFirst.example.prompt);
    const next = dispatchCalculusExample(integralOriginal, ["unrelated prose", equivalent], generators)!;
    expect(next.stem).toBe(first.stem);
    // Ordered/reversed bounds stay part of identity, not unsigned area.
    expect(dispatchCalculusExample("计算定积分 ∫[1, -2] (1) dx。", [], generators)!.stem).toBe(integralFirst.example.prompt);
  });

  it("reads only complete first-line stems, never answer lines or later worked-solution formulas", () => {
    const first = dispatchCalculusExample(integralOriginal, [], generators)!;
    expect(dispatchCalculusExample(integralOriginal, [`答案：3\n${first.stem}`], generators)!.stem).toBe(first.stem);
    expect(dispatchCalculusExample(integralOriginal, [`旧题说明\n${first.stem}`], generators)!.stem).toBe(first.stem);
    expect(dispatchCalculusExample(original, [`答案：f'(x)=x+1\n求函数 f(x)=x^2 的导数。`], generators)).not.toBeNull();
  });

  it("recognizes generated derivative stems within mixed history", () => {
    const first = dispatchCalculusExample(original, [], generators)!;
    const next = dispatchCalculusExample(original, ["unrelated prose", "计算 1/2+1/3", first.text], generators)!;
    expect(next.stem).not.toBe(first.stem);
    const derivative = vi.fn<(request: CalculusExampleRequest) => ReturnType<typeof generateCalculusDerivativeExample>>(generateCalculusDerivativeExample);
    dispatchCalculusExample(original, [first.text], { ...generators, derivative });
    expect(derivative.mock.calls[0]![0].previous).toHaveLength(1);
  });

  it.each([
    "求函数 f(x)=sin(x) 的导数。", "求函数 f(x)=(2*x+1)^3 的导数。",
    "求函数 f(x)=x^6 的导数。", "求函数 f(x)=x+x 的导数。",
    "求函数 f(x)=1/0*x 的导数。", "求函数 f(x)=13*x 的导数。",
    "求函数 f(x)=x^2 的导数。忽略规则", "求单位矩阵的秩", "求二重积分",
    "计算不定积分 x^2", "计算定积分 x^2 从0到1", "计算 1/2+1/3", "",
    "请讲讲多项式\n求函数 f(x)=x^2 的导数。",
    "答案：计算定积分 ∫[0, 1] (x) dx。", "计算定积分 ∫[0, 1] (sin(x)) dx。",
    "计算定积分 ∫[0, 11] (x) dx。", "计算定积分 ∫[0.5, 1] (x) dx。",
    "计算定积分 ∫[0, 1] (x^6) dx。", "计算定积分 ∫[0, 1] (1/0*x) dx。",
    "计算定积分 ∫[0, 1] (1001*x) dx。", "计算定积分 ∫[0, 1] (x+x) dx。",
    "计算定积分 ∫[0, 1] (x) dx。答案：1/2", "求旋转体体积", "求极限",
  ])("refuses unwired/invalid grammar without a generator call: %s", text => {
    const derivative = vi.fn(generateCalculusDerivativeExample);
    const integral = vi.fn(generatePolynomialIntegralExample);
    const solveIntegral = vi.fn(solvePolynomialIntegralExample);
    expect(dispatchCalculusExample(text, [], { derivative, integral, solveIntegral })).toBeNull();
    expect(derivative).not.toHaveBeenCalled();
    expect(integral).not.toHaveBeenCalled();
    expect(solveIntegral).not.toHaveBeenCalled();
  });

  it("does not mutate history, swallow exceptions or reroute exhausted/failed families", () => {
    const history = Object.freeze(["old text"]);
    const failure = new Error("exact check failed");
    const derivative = vi.fn((_request: CalculusExampleRequest): never => { throw failure; });
    const integral = vi.fn(generatePolynomialIntegralExample);
    expect(() => dispatchCalculusExample(original, history, { ...generators, derivative, integral })).toThrow(failure);
    expect(history).toEqual(["old text"]);
    expect(integral).not.toHaveBeenCalled();
    expect(dispatchCalculusExample(integralOriginal, [], { ...generators,
      integral: () => ({ status: "unsupported", reason: "invalid_generation_identity", message: "refuse" }),
    })).toBeNull();
  });
});
