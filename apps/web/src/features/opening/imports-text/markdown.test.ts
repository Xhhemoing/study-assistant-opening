import { describe, expect, it } from "vitest";
import { extractKeySteps, prepareCapture } from "./markdown";

describe("pasted Markdown", () => {
  it("keeps formulae and fences, cleans controls and uses a safe first-line filename", () => {
    const capture = prepareCapture({ content: "\ufeff# 矩阵/推导..\r\n\r\n1. 令 A = B²\u0000\r\n2. 推出结果\u202e" });
    expect(capture.name).toBe("矩阵 推导.md");
    expect(capture.markdown).toBe("# 矩阵/推导..\n\n1. 令 A = B²\n2. 推出结果\n");
    expect(capture.keySteps).toEqual(["令 A = B²", "推出结果"]);
  });

  it("prefers the learner's own steps, removes repeats and keeps at most three", () => {
    const capture = prepareCapture({ content: "1. 外部答案", title: "我的解释", providerHint: "kimi",
      keyStepSummary: "第一步：换元\n2. 确定范围\n2. 确定范围\n- 验证结果\n- 额外说明" });
    expect(capture.keySteps).toEqual(["换元", "确定范围", "验证结果"]);
    expect(capture.markdown).toContain("## 我的关键步骤");
    expect(capture.markdown).toContain("讲解来源：Kimi");
  });

  it("ignores list-like lines inside fences and still handles unstructured prose", () => {
    expect(extractKeySteps("~~~txt\n1. 代码示例\n~~~\n### Step 1: Establish the base case")).toEqual(["Establish the base case"]);
    expect(extractKeySteps("设函数连续，由介值定理可知有零点。")).toEqual(["设函数连续，由介值定理可知有零点。"]);
    expect(extractKeySteps("\u0000 \n", "摘要")).toEqual([]);
    expect(prepareCapture({ content: "Use 3.14." }).name).toBe("Use 3.14.md");
    expect(extractKeySteps("# 估算\n3.14 是近似值")).toEqual(["3.14 是近似值"]);
    expect(extractKeySteps("引言\n**步骤 1：**代入")).toEqual(["代入"]);
  });
});
