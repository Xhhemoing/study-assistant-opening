import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FlowDiagramParams } from "../../capabilities/flow-diagram";
import { ComparisonBarsView, orderBars } from "./comparison-bars-view";
import { FlowDiagramView, chainOrder } from "./flow-diagram-view";

const chain: FlowDiagramParams = {
  nodes: [
    { id: "b", label: "做练习" },
    { id: "a", label: "读教材" },
    { id: "c", label: "复盘" },
  ],
  edges: [
    { from: "a", to: "b", relation: "sequence" },
    { from: "b", to: "c", relation: "hypothesis" },
  ],
};

describe("FlowDiagramView", () => {
  it("orders a chain by its edges, not by node array order", () => {
    expect(chainOrder(chain)!.map((n) => n.label)).toEqual(["读教材", "做练习", "复盘"]);
  });

  it("marks non-sequence relations visibly and for screen readers", () => {
    const html = renderToStaticMarkup(createElement(FlowDiagramView, { blockId: "f", params: chain, mode: "static", prefs: {} }));
    expect(html.indexOf("读教材")).toBeLessThan(html.indexOf("做练习"));
    expect(html).toContain("↓ 假设");
    expect(html).toContain("与上一步的关系：假设");
    expect(html).toContain("border-dashed");
  });

  it("falls back to the relation list for branching graphs", () => {
    const branching: FlowDiagramParams = {
      nodes: [
        { id: "a", label: "需求" },
        { id: "b", label: "前端" },
        { id: "c", label: "后端" },
      ],
      edges: [
        { from: "a", to: "b", relation: "dependency" },
        { from: "a", to: "c", relation: "dependency" },
      ],
    };
    expect(chainOrder(branching)).toBeNull();
    const html = renderToStaticMarkup(createElement(FlowDiagramView, { blockId: "f", params: branching, mode: "static", prefs: {} }));
    expect(html).toContain("需求 →（依赖）前端");
    expect(html).not.toContain("<ol");
  });
});

describe("ComparisonBarsView", () => {
  const params = { measure: "投入时间", unit: "分钟", bars: [{ label: "阅读", value: 25 }, { label: "练习", value: 40 }] };

  it("keeps values as text and scales bars from a shared zero baseline", () => {
    const html = renderToStaticMarkup(createElement(ComparisonBarsView, { blockId: "c", params, mode: "static", prefs: {} }));
    expect(html).toContain("投入时间（分钟）");
    expect(html).toContain("25 分钟");
    expect(html).toContain('width="62.5"');
    expect(html).toContain('width="100"');
    expect(html).not.toContain("按数值排序");
    // Long labels wrap instead of being cut off.
    expect(html).not.toContain("truncate");
  });

  it("offers a local sort only in interactive mode and labels missing units", () => {
    const html = renderToStaticMarkup(
      createElement(ComparisonBarsView, { blockId: "c", params: { ...params, unit: undefined }, mode: "interactive", prefs: {} }),
    );
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("未声明单位");
    expect(orderBars(params.bars, "descending").map((b) => b.label)).toEqual(["练习", "阅读"]);
    expect(params.bars.map((b) => b.label)).toEqual(["阅读", "练习"]);
  });
});
