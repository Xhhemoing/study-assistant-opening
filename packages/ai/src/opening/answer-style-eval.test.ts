import { describe, expect, it } from "vitest";
import {
  ANSWER_STYLE_BUDGETS,
  scoreAnswerStyle,
  summarizeAnswerStyle,
  type AnswerStyleScore,
} from "./answer-style-eval";
import { ANSWER_STYLE_SAMPLES, type AnswerStyleCategory } from "./answer-style-samples";

function scoreOf(
  text: string,
  category: AnswerStyleCategory = "concept",
  mode: "hint" | "explain" | "listen" | "think_together" = "explain",
) {
  return scoreAnswerStyle(text, { category, mode });
}

function chars(n: number, ch = "字"): string {
  return ch.repeat(n);
}

describe("scoreAnswerStyle — first paragraph directness", () => {
  it("counts a short direct first paragraph as ≤2 sentences", () => {
    const r = scoreOf("结论先说。细节随后补充。\n\n后面还有第二段。");
    expect(r.firstParagraphSentences).toBe(2);
    expect(r.directFirstParagraph).toBe(true);
    expect(r.pass).toBe(true);
  });

  it("flags a padded first paragraph with more than 2 sentences", () => {
    const r = scoreOf("首先回顾背景。然后说明动机。最后才给出答案。\n\n正文。");
    expect(r.firstParagraphSentences).toBe(3);
    expect(r.directFirstParagraph).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("treats newlines inside the first paragraph as sentence breaks", () => {
    const r = scoreOf("第一行说法\n第二行说法\n第三行说法");
    expect(r.firstParagraphSentences).toBe(3);
    expect(r.directFirstParagraph).toBe(false);
  });
});

describe("scoreAnswerStyle — category budgets", () => {
  const cases: Array<{ category: AnswerStyleCategory; budget: number }> = [
    { category: "fact", budget: 150 },
    { category: "concept", budget: 600 },
    { category: "comparison", budget: 600 },
    { category: "process", budget: 600 },
    { category: "derivation", budget: 1200 },
    { category: "code", budget: 1200 },
  ];

  it("exports the expected budget table", () => {
    for (const { category, budget } of cases) {
      expect(ANSWER_STYLE_BUDGETS[category]).toBe(budget);
    }
  });

  for (const { category, budget } of cases) {
    it(`${category}: exactly ${budget} chars passes, +1 fails`, () => {
      const ok = scoreOf(chars(budget), category);
      expect(ok.charCount).toBe(budget);
      expect(ok.withinBudget).toBe(true);
      expect(ok.pass).toBe(true);

      const over = scoreOf(chars(budget + 1), category);
      expect(over.charCount).toBe(budget + 1);
      expect(over.withinBudget).toBe(false);
      expect(over.pass).toBe(false);
    });
  }

  it("ignores whitespace when counting characters", () => {
    const r = scoreOf("a b\nc\t", "fact");
    expect(r.charCount).toBe(3);
  });
});

describe("scoreAnswerStyle — fences hide rawHtml and math dollars", () => {
  it("does not count <div> inside a code fence as rawHtml", () => {
    const r = scoreOf("答案如下。\n\n```html\n<div>hi</div>\n```");
    expect(r.rawHtml).toBe(false);
    expect(r.pass).toBe(true);
  });

  it("flags <div> outside fences as rawHtml", () => {
    const r = scoreOf("看这里 <div>坏</div>。");
    expect(r.rawHtml).toBe(true);
    expect(r.pass).toBe(false);
  });

  it("does not count $ inside a code fence toward unbalancedMath", () => {
    const r = scoreOf("示例。\n\n```\nprice = $5\n```");
    expect(r.unbalancedMath).toBe(false);
    expect(r.pass).toBe(true);
  });
});

describe("scoreAnswerStyle — math delimiters", () => {
  it("treats paired $$...$$ as balanced", () => {
    const r = scoreOf("面积 $$S=\\pi r^2$$ 如上。");
    expect(r.unbalancedMath).toBe(false);
    expect(r.pass).toBe(true);
  });

  it("treats paired $...$ as balanced", () => {
    const r = scoreOf("变量 $x$ 为正。");
    expect(r.unbalancedMath).toBe(false);
  });

  it("flags a single unpaired $", () => {
    const r = scoreOf("价格约 $5 美元。");
    expect(r.unbalancedMath).toBe(true);
    expect(r.pass).toBe(false);
  });

  it("ignores escaped \\$", () => {
    const r = scoreOf("字面量 \\$ 不是公式。");
    expect(r.unbalancedMath).toBe(false);
  });
});

describe("scoreAnswerStyle — hintViolation", () => {
  it("hint + heading is a violation", () => {
    const r = scoreOf("# 提示\n\n想想定义。", "concept", "hint");
    expect(r.headingCount).toBeGreaterThan(0);
    expect(r.hintViolation).toBe(true);
    expect(r.pass).toBe(false);
  });

  it("hint + 最终答案 is a violation", () => {
    const r = scoreOf("最终答案是 42。", "fact", "hint");
    expect(r.hintViolation).toBe(true);
  });

  it("hint + 答案是 is a violation", () => {
    const r = scoreOf("答案是三。", "fact", "hint");
    expect(r.hintViolation).toBe(true);
  });

  it("hint + 综上 is a violation", () => {
    const r = scoreOf("综上可得结论。", "fact", "hint");
    expect(r.hintViolation).toBe(true);
  });

  it("explain with heading or 最终答案 is not hintViolation", () => {
    const withHeading = scoreOf("# 讲解\n\n结论。", "concept", "explain");
    expect(withHeading.hintViolation).toBe(false);

    const withAnswer = scoreOf("最终答案是 1。", "fact", "explain");
    expect(withAnswer.hintViolation).toBe(false);
  });
});

describe("summarizeAnswerStyle", () => {
  it("computes rates and counts", () => {
    const results: AnswerStyleScore[] = [
      scoreOf("短答。", "fact", "explain"),
      scoreOf("首先铺垫。然后继续。最后才答。", "fact", "explain"),
      scoreOf(chars(151), "fact", "explain"),
      scoreOf("含 <span>x</span>。", "fact", "explain"),
      scoreOf("落单 $ 。", "fact", "explain"),
      scoreOf("最终答案是零。", "fact", "hint"),
    ];
    const s = summarizeAnswerStyle(results);
    expect(s.total).toBe(6);
    expect(s.passed).toBe(1);
    expect(s.directRate).toBeCloseTo(5 / 6);
    expect(s.withinBudgetRate).toBeCloseTo(5 / 6);
    expect(s.rawHtmlCount).toBe(1);
    expect(s.unbalancedMathCount).toBe(1);
    expect(s.hintViolationCount).toBe(1);
  });

  it("returns zeros for an empty list", () => {
    expect(summarizeAnswerStyle([])).toEqual({
      total: 0,
      passed: 0,
      directRate: 0,
      withinBudgetRate: 0,
      rawHtmlCount: 0,
      unbalancedMathCount: 0,
      hintViolationCount: 0,
    });
  });
});

describe("ANSWER_STYLE_SAMPLES", () => {
  it("has 30 samples with unique ids", () => {
    expect(ANSWER_STYLE_SAMPLES).toHaveLength(30);
    const ids = ANSWER_STYLE_SAMPLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(30);
  });

  it("has 5 samples per category", () => {
    const categories: AnswerStyleCategory[] = [
      "fact",
      "concept",
      "derivation",
      "comparison",
      "process",
      "code",
    ];
    for (const category of categories) {
      expect(ANSWER_STYLE_SAMPLES.filter((s) => s.category === category)).toHaveLength(5);
    }
  });

  it("each category includes at least one hint and one explain", () => {
    const categories: AnswerStyleCategory[] = [
      "fact",
      "concept",
      "derivation",
      "comparison",
      "process",
      "code",
    ];
    for (const category of categories) {
      const modes = new Set(
        ANSWER_STYLE_SAMPLES.filter((s) => s.category === category).map((s) => s.mode),
      );
      expect(modes.has("hint")).toBe(true);
      expect(modes.has("explain")).toBe(true);
    }
  });
});
