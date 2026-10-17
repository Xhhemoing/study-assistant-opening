import { describe, expect, it } from "vitest";
import { EXAM_SPRINT_PACK } from "./catalog";

const bank = EXAM_SPRINT_PACK.questions;
function item(id: string) {
  const found = bank.find(question => question.id === id);
  if (!found) throw new Error(`Missing question ${id}`);
  return found;
}
function selectedLabel(id: string) {
  const question = item(id);
  const selected = question.options.find(option => option.id === question.answer);
  if (!selected) throw new Error(`Invalid answer for ${id}`);
  return selected.label;
}
function derivative(fn: (x: number) => number, x: number) {
  const h = 1e-5;
  return (fn(x + h) - fn(x - h)) / (2 * h);
}
function integrate(fn: (x: number) => number, a: number, b: number) {
  const n = 2000;
  const h = (b - a) / n;
  let total = fn(a) + fn(b);
  for (let k = 1; k < n; k++) total += (k % 2 === 0 ? 2 : 4) * fn(a + k * h);
  return total * h / 3;
}
function checkNumericAnswer(id: string, values: Record<string, number>, expected: number, precision = 7) {
  const selected = values[selectedLabel(id)];
  expect(selected).toBeDefined();
  expect(selected).toBeCloseTo(expected, precision);
  const matching = item(id).options.filter(option => Math.abs(values[option.label]! - expected) < 10 ** -precision);
  expect(matching.map(option => option.id)).toEqual([item(id).answer]);
}

describe("Math I sprint editorial catalog", () => {
  it("has separate short mocks and enough unseen families for each skill's retest", () => {
    expect(new Set(bank.map(question => question.id)).size).toBe(bank.length);
    expect(new Set(bank.map(question => question.prompt)).size).toBe(bank.length);
    for (const lesson of EXAM_SPRINT_PACK.lessons) {
      const training = bank.filter(question => question.pool === "training" && question.skillId === lesson.id);
      expect(training.length).toBeGreaterThanOrEqual(3);
      expect(new Set(training.map(question => question.familyId)).size).toBeGreaterThanOrEqual(2);
      expect(training.some(question => question.difficulty === "foundation")).toBe(true);
      expect(training.some(question => question.difficulty === "transfer")).toBe(true);
    }
    for (const pool of ["mock-a", "mock-b"] as const) {
      const questions = bank.filter(question => question.pool === pool);
      expect(questions).toHaveLength(10);
      const minutes = questions.reduce((total, question) => total + question.estimatedMinutes, 0);
      expect(minutes).toBeGreaterThanOrEqual(20);
      expect(minutes).toBeLessThanOrEqual(30);
    }
    for (const question of bank) {
      expect(question.options).toHaveLength(4);
      expect(new Set(question.options.map(option => option.label)).size).toBe(4);
      expect(question.options.filter(option => option.id === question.answer)).toHaveLength(1);
      expect(EXAM_SPRINT_PACK.lessons.find(lesson => lesson.id === question.lessonId)?.topicId).toBe(question.topicId);
    }
  });

  it("checks complex multiplication, division and all roots by substituting them", () => {
    type Complex = [number, number];
    const multiply = ([a, b]: Complex, [c, d]: Complex): Complex => [a * c - b * d, a * d + b * c];
    const power = (z: Complex, n: number) => {
      let result: Complex = [1, 0];
      for (let k = 0; k < n; k++) result = multiply(result, z);
      return result;
    };
    const cases: Array<{ id: string; labels: Record<string, Complex>; expected: Complex }> = [
      { id: "train-complex-product", labels: { "1 + 5i": [1, 5], "5 + 5i": [5, 5], "5 − 5i": [5, -5], "3 + i": [3, 1] }, expected: multiply([1, 2], [3, -1]) },
      { id: "mock-a-complex-product", labels: { "3 − 4i": [3, -4], "5 − 4i": [5, -4], "3 + 4i": [3, 4], "4 − i": [4, -1] }, expected: power([2, -1], 2) },
    ];
    for (const test of cases) expect(test.labels[selectedLabel(test.id)]).toEqual(test.expected);
    const quotient: Record<string, Complex> = { "(3 + i)/2": [1.5, 0.5], "(1 − 3i)/2": [0.5, -1.5], "1 + 3i": [1, 3], "(1 + 3i)/2": [0.5, 1.5] };
    expect(multiply(quotient[selectedLabel("train-complex-quotient")]!, [1, -1])).toEqual([2, 1]);
    const cubeRoots: Record<string, Complex[]> = {
      "{2, −1 + √3i, −1 − √3i}": [[2, 0], [-1, Math.sqrt(3)], [-1, -Math.sqrt(3)]],
      "{2, 2i, −2i}": [[2, 0], [0, 2], [0, -2]],
      "{2, 1 + √3i, 1 − √3i}": [[2, 0], [1, Math.sqrt(3)], [1, -Math.sqrt(3)]],
      "{−2, 1 + √3i, 1 − √3i}": [[-2, 0], [1, Math.sqrt(3)], [1, -Math.sqrt(3)]],
    };
    const roots = cubeRoots[selectedLabel("train-complex-cube-roots")]!;
    expect(roots).toHaveLength(3);
    for (const root of roots) {
      const cubed = power(root, 3);
      expect(cubed[0]).toBeCloseTo(8, 10);
      expect(cubed[1]).toBeCloseTo(0, 10);
    }
    checkNumericAnswer("train-complex-modulus", { "4": 4, "2": 2, "−4": -4, "8": 8 }, Math.hypot(...power([1, 1], 4)));
  });

  it("checks affine recurrences using their actual iterates", () => {
    let first = 0;
    let second = 1;
    for (let n = 1; n < 60; n++) {
      first = (first + 2) / 2;
      second = (second + 6) / 3;
    }
    checkNumericAnswer("train-sequence-recursion", { "1": 1, "2": 2, "0": 0, "不存在": Number.NaN }, first);
    checkNumericAnswer("mock-a-recursion", { "2": 2, "6": 6, "3": 3, "不存在": Number.NaN }, second);
  });

  it.each([
    { id: "train-parts-exponential", integrand: (x: number) => x * Math.exp(x), primitives: {
      "xeˣ + C": (x: number) => x * Math.exp(x),
      "eˣ(x − 1) + C": (x: number) => Math.exp(x) * (x - 1),
      "eˣ(x + 1) + C": (x: number) => Math.exp(x) * (x + 1),
      "eˣx²/2 + C": (x: number) => Math.exp(x) * x * x / 2,
    } },
    { id: "train-parts-logarithm", integrand: Math.log, primitives: {
      "1/x + C": (x: number) => 1 / x,
      "x ln x + C": (x: number) => x * Math.log(x),
      "x ln x − x + C": (x: number) => x * Math.log(x) - x,
      "(ln x)²/2 + C": (x: number) => Math.log(x) ** 2 / 2,
    } },
    { id: "mock-b-parts-trigonometry", integrand: (x: number) => x * Math.cos(x), primitives: {
      "x sin x+cos x+C": (x: number) => x * Math.sin(x) + Math.cos(x),
      "x sin x−cos x+C": (x: number) => x * Math.sin(x) - Math.cos(x),
      "x cos x−sin x+C": (x: number) => x * Math.cos(x) - Math.sin(x),
      "x sin x+C": (x: number) => x * Math.sin(x),
    } },
    { id: "mock-b-fractions-repeated", integrand: (x: number) => (2 * x + 3) / (x + 1) ** 2, primitives: {
      "2ln|x+1|+1/(x+1)+C": (x: number) => 2 * Math.log(Math.abs(x + 1)) + 1 / (x + 1),
      "ln|x+1|−1/(x+1)+C": (x: number) => Math.log(Math.abs(x + 1)) - 1 / (x + 1),
      "2ln|x+1|+C": (x: number) => 2 * Math.log(Math.abs(x + 1)),
      "2ln|x+1|−1/(x+1)+C": (x: number) => 2 * Math.log(Math.abs(x + 1)) - 1 / (x + 1),
    } },
  ])("differentiates the selected primitive for $id back to its integrand", ({ id, integrand, primitives }) => {
    const fn = (primitives as Record<string, (x: number) => number>)[selectedLabel(id)]!;
    expect(fn).toBeTypeOf("function");
    for (const x of [0.2, 0.7, 1.5, 3]) expect(derivative(fn, x)).toBeCloseTo(integrand(x), 5);
  });

  it("recombines the selected partial fractions before integration", () => {
    const options: Record<string, [number, number]> = { "(1,2)": [1, 2], "(3,5)": [3, 5], "(−2,5)": [-2, 5], "(2,1)": [2, 1] };
    const [a, b] = options[selectedLabel("train-fractions-coefficients")]!;
    for (const x of [-4, -1.5, -0.5, 0, 2, 10]) {
      expect(a / (x + 1) + b / (x + 2)).toBeCloseTo((3 * x + 5) / ((x + 1) * (x + 2)), 10);
    }
    const splits: Record<string, (x: number) => number> = {
      "1/x − 1/(x + 1)": x => 1 / x - 1 / (x + 1),
      "1/x + 1/(x + 1)": x => 1 / x + 1 / (x + 1),
      "−1/x + 1/(x + 1)": x => -1 / x + 1 / (x + 1),
      "2/x − 1/(x + 1)": x => 2 / x - 1 / (x + 1),
    };
    for (const x of [-3, -0.5, 0.5, 2]) expect(splits[selectedLabel("train-fractions-split")]!(x)).toBeCloseTo(1 / (x * (x + 1)), 10);
  });

  it("checks definite integrals and sign-changing areas using independent quadrature", () => {
    checkNumericAnswer("train-parts-definite", {
      "e³/3": Math.exp(3) / 3, "(2e³ − 1)/9": (2 * Math.exp(3) - 1) / 9,
      "(e³ + 1)/3": (Math.exp(3) + 1) / 3, "(2e³ + 1)/9": (2 * Math.exp(3) + 1) / 9,
    }, integrate(x => x * Math.exp(3 * x), 0, 1));
    checkNumericAnswer("mock-a-parts-definite", { "1": 1, "e−1": Math.E - 1, "e": Math.E, "0": 0 }, integrate(x => x * Math.exp(x), 0, 1));
    checkNumericAnswer("train-fractions-definite", {
      "ln 2": Math.log(2), "ln(3/2)": Math.log(1.5), "ln(4/3)": Math.log(4 / 3), "ln(3/4)": Math.log(0.75),
    }, integrate(x => 1 / ((x + 1) * (x + 2)), 0, 1));
    checkNumericAnswer("mock-a-fractions-definite", {
      "ln(3/4)": Math.log(0.75), "ln2": Math.log(2), "ln(3/2)": Math.log(1.5), "ln(4/3)": Math.log(4 / 3),
    }, integrate(x => 1 / (x * (x + 1)), 1, 2));
    // Split at the actual zero so quadrature does not blur the absolute-value corner.
    checkNumericAnswer("train-ftc-area-sign", { "6": 6, "20/3": 20 / 3, "22/3": 22 / 3, "2": 2 },
      integrate(x => Math.abs(x * x - 1), 0, 1) + integrate(x => Math.abs(x * x - 1), 1, 3));
    checkNumericAnswer("mock-b-ftc-between-curves", { "1/2": 0.5, "1/3": 1 / 3, "1/6": 1 / 6, "−1/6": -1 / 6 }, integrate(x => x - x * x, 0, 1));
  });

  it("checks FTC chain factors and the moving lower-limit subtraction", () => {
    const upper: Record<string, (x: number) => number> = {
      "cos(x²)": x => Math.cos(x * x), "2x cos(x²)": x => 2 * x * Math.cos(x * x),
      "sin(x²)": x => Math.sin(x * x), "2x sin(x²)": x => 2 * x * Math.sin(x * x),
    };
    const two: Record<string, (x: number) => number> = {
      "3x²": x => 3 * x * x, "4x²": x => 4 * x * x, "8x²": x => 8 * x * x, "7x²": x => 7 * x * x,
    };
    for (const x of [-1.3, -0.2, 0.4, 1.2]) {
      expect(upper[selectedLabel("train-ftc-chain")]!(x)).toBeCloseTo(derivative(t => integrate(Math.cos, 0, t * t), x), 5);
      expect(two[selectedLabel("train-ftc-two-limits")]!(x)).toBeCloseTo(derivative(t => integrate(u => u * u, t, 2 * t), x), 5);
    }
    checkNumericAnswer("mock-a-ftc-chain", { "1": 1, "3": 3, "1/3": 1 / 3, "0": 0 }, derivative(x => integrate(Math.sqrt, 1, x ** 3), 1), 5);
  });

  it("checks Taylor cancellation numerically from both sides", () => {
    for (const x of [-0.001, 0.001]) {
      checkNumericAnswer("train-taylor-exponential", { "1": 1, "1/2": 0.5, "0": 0, "2": 2 }, (Math.expm1(x) - x) / x ** 2, 3);
      checkNumericAnswer("train-taylor-logarithm", { "−1/3": -1 / 3, "1/2": 0.5, "1/3": 1 / 3, "0": 0 }, (Math.log1p(x) - x + x * x / 2) / x ** 3, 3);
      checkNumericAnswer("mock-a-taylor-cosine", { "0": 0, "1": 1, "−1/2": -0.5, "1/2": 0.5 }, (1 - Math.cos(x)) / x ** 2, 3);
    }
    for (const x of [-0.0001, 0.0001]) checkNumericAnswer("mock-b-taylor-chain", { "1/2": 0.5, "1": 1, "2": 2, "4": 4 }, (Math.expm1(2 * x) - 2 * x) / x ** 2, 3);
  });

  it("checks maximum errors for each fixed n before considering convergence", () => {
    for (const n of [2, 5, 20, 100]) {
      const scaledPeak = (x: number) => 2 * n * x / (1 + n * n * x * x);
      const peak = scaledPeak(1 / n);
      checkNumericAnswer("train-uniform-moving-peak", { "1/n": 1 / n, "2n/(1+n²)": 2 * n / (1 + n * n), "1": 1, "0": 0 }, peak);
      for (let k = 0; k <= 100; k++) expect(scaledPeak(k / 100)).toBeLessThanOrEqual(peak + 1e-12);
      expect(derivative(scaledPeak, 1 / n - 1 / (10 * n))).toBeGreaterThan(0);
      expect(derivative(scaledPeak, 1 / n + 1 / (10 * n))).toBeLessThan(0);
    }
    const rationalChoices: Record<string, (n: number) => number> = {
      "最大误差1，不一致": () => 1, "最大误差1/n，不一致": n => 1 / n,
      "最大误差1/(n+1)，一致": n => 1 / (n + 1), "最大误差0，一致": () => 0,
    };
    const restrictedChoices: Record<string, (n: number) => number> = {
      "最大误差 n/(1+n²)，一致": n => n / (1 + n * n), "最大误差1/2，对所有n都不变，不一致": () => 0.5,
      "最大误差2n/(1+4n²)，一致": n => 2 * n / (1 + 4 * n * n), "最大误差1，不一致": () => 1,
    };
    for (const n of [1, 2, 10, 100]) {
      const errors = Array.from({ length: 101 }, (_, k) => (k / 100) / (n + k / 100));
      expect(rationalChoices[selectedLabel("mock-a-uniform-rational")]!(n)).toBeCloseTo(Math.max(...errors), 10);
      const restricted = Array.from({ length: 101 }, (_, k) => n * (1 + k / 100) / (1 + n * n * (1 + k / 100) ** 2));
      expect(restrictedChoices[selectedLabel("mock-b-uniform-restricted-peak")]!(n)).toBeCloseTo(Math.max(...restricted), 10);
    }
    // A diagonal x_n proves a persistent error even though each fixed x<1 converges.
    for (const n of [1, 2, 10, 100]) expect((0.5 ** (1 / n)) ** n).toBeCloseTo(0.5, 12);
    expect(selectedLabel("train-uniform-boundary")).toBe("不一致收敛，sup|fₙ−f|=1");
  });

  it("checks the geometric sum with partial sums, including the n=1 starting index", () => {
    let partialSum = 0;
    for (let n = 1; n <= 30; n++) partialSum += (1 / 3) ** n;
    checkNumericAnswer("mock-b-series-geometric", { "3/2": 1.5, "1/2": 0.5, "1/3": 1 / 3, "发散": Infinity }, partialSum);
  });
});
