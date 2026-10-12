import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../capability";
import { STANDARD_CAPABILITIES } from "../capabilities";
import { artifactToText, decideArtifact } from "../decide";
import { planFromRules } from "./rules";

const registry = createCapabilityRegistry(STANDARD_CAPABILITIES);
const plan = (answer: string, question?: string) => planFromRules({ answer, question, artifactId: "turn-1" });

describe("planFromRules: flows", () => {
  it("turns a stated arrow chain into a sequence diagram", () => {
    const { artifact, reason } = plan("建议这样复习：\n流程：**读教材** → 做练习 → 对答案 → 复盘错题。\n其余照常。");
    expect(reason).toContain("步骤顺序");
    expect(artifact!.blocks[0]).toMatchObject({
      capability: "flow-diagram@1",
      params: {
        nodes: [
          { id: "s1", label: "读教材" },
          { id: "s2", label: "做练习" },
          { id: "s3", label: "对答案" },
          { id: "s4", label: "复盘错题" },
        ],
        edges: [
          { from: "s1", to: "s2", relation: "sequence" },
          { from: "s2", to: "s3", relation: "sequence" },
          { from: "s3", to: "s4", relation: "sequence" },
        ],
      },
    });
    expect(artifact!.blocks[0]!.limits.join()).toContain("不代表已验证的因果");
    expect(decideArtifact(artifact!, registry).every((d) => d.ok)).toBe(true);
  });

  it("ignores short chains, code, implication and code-like arrows", () => {
    expect(plan("A → B").artifact).toBeNull();
    expect(plan("```\n读取 -> 解析 -> 写入\n```").artifact).toBeNull();
    expect(plan("可逆 ⇒ 行列式非零 ⇒ 有唯一解").artifact).toBeNull();
    expect(plan("const f = a => b => c").artifact).toBeNull();
    expect(plan("x -> y -> z").artifact).toBeNull(); // single-letter tokens are not steps
    expect(plan("读 → 读 → 读").artifact).toBeNull(); // duplicate labels
  });
});

describe("planFromRules: comparisons", () => {
  const table = [
    "| 方法 | 投入时间（分钟） | 备注 |",
    "| --- | ---: | --- |",
    "| 阅读 | 25 | 先读 |",
    "| 练习 | 40 | 重点 |",
    "| 复盘 | 15 | 收尾 |",
  ].join("\n");

  it("charts the first non-negative numeric column with its stated unit", () => {
    const { artifact } = plan(`三种方式对比：\n\n${table}`);
    expect(artifact!.blocks[0]).toMatchObject({
      capability: "comparison-bars@1",
      params: {
        measure: "投入时间",
        unit: "分钟",
        bars: [
          { label: "阅读", value: 25 },
          { label: "练习", value: 40 },
          { label: "复盘", value: 15 },
        ],
      },
    });
    expect(artifactToText(artifact!, registry)).toContain("投入时间：阅读 25 分钟；练习 40 分钟；复盘 15 分钟");
  });

  it("reads per-cell units and refuses mixed units, negatives, years and too few rows", () => {
    const cellUnits = "| 项 | 占比 |\n|---|---|\n| A | 30% |\n| B | 70% |";
    expect(plan(cellUnits).artifact!.blocks[0]!.params).toMatchObject({ measure: "占比", unit: "%" });
    expect(plan("| 项 | 时长 |\n|---|---|\n| A | 3分钟 |\n| B | 2小时 |").artifact).toBeNull();
    expect(plan("| 项 | 变化 |\n|---|---|\n| A | -3 |\n| B | 5 |").artifact).toBeNull();
    expect(plan("| 事件 | 年份 |\n|---|---|\n| A | 1998 |\n| B | 2004 |").artifact).toBeNull();
    expect(plan("| 项 | 值 |\n|---|---|\n| A | 1 |").artifact).toBeNull();
    expect(plan("| 项 | 说明 |\n|---|---|\n| A | 较快 |\n| B | 较慢 |").artifact).toBeNull(); // no invented scores
  });

  it("can produce a flow and a chart from one answer", () => {
    const { artifact, reason } = plan(`步骤：读取 → 计算 → 汇报\n\n${table}`);
    expect(artifact!.blocks.map((b) => b.capability)).toEqual(["flow-diagram@1", "comparison-bars@1"]);
    expect(reason).toBe("回答写出了步骤顺序；回答给出了同一列的数值");
  });
});

describe("planFromRules: restraint", () => {
  it("keeps prose when the reader asked for text only or nothing is structured", () => {
    expect(plan("读 → 练 → 复盘", "一句话告诉我怎么复习，不要图")).toEqual({ artifact: null, reason: "遵从只要文字的要求" });
    expect(plan("线性变换保持加法和数乘。").artifact).toBeNull();
    expect(plan("").artifact).toBeNull();
  });
});
