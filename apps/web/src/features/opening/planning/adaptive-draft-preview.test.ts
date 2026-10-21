import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanDraft } from "@aistudy/contracts";
import { AdaptiveDraftDetails } from "./adaptive-draft-preview";

const draft: PlanDraft = {
  id: "draft", date: "2026-10-16", version: 1, baseVersion: 0, status: "draft",
  blocks: [{ taskId: "selected", start: "2026-10-16T11:00:00Z", end: "2026-10-16T11:25:00Z", reason: "旧原因" },
    { taskId: "deselected", start: "2026-10-16T11:30:00Z", end: "2026-10-16T11:55:00Z", reason: "原有原因" }],
  suggestedTasks: ["selected", "deselected", "blocked"].map((id) => ({ id, key: `suggestion-${id}`, title: `学习 ${id}`, minutes: 25, kind: "weak_skill", courseId: null, skillLabel: "矩阵乘法", reasonCode: "weak_skill", reason: "核对后需要巩固" })),
  reasons: { selected: { code: "weak_skill", label: "最近核对错误，先巩固这一步" } },
  unscheduledTaskIds: ["blocked"], unscheduled: [{ taskId: "blocked", reason: "duration_exceeds_free_slots" }], strategyVersion: "adaptive-1",
};

describe("adaptive draft details", () => {
  it("keeps a persisted declined suggestion unselectable without relabeling it as unscheduled or a learner skip", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveDraftDetails, { draft: { ...draft, rejectedSuggestedKeys: ["suggestion-selected"] },
      tasks: [], selectedKeys: ["suggestion-selected"], disabled: false, onSelectionChange: vi.fn() }));
    expect(html).toContain("已反馈不适合，今天不再推荐");
    expect(html).not.toContain("已跳过");
    expect(html.match(/学习 selected/g)).toHaveLength(1);
    expect(html).not.toContain('checked="" aria-checked="true"');
  });
  it("shows stored reasons with a legacy fallback and makes unscheduled suggestions unavailable", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveDraftDetails, { draft, tasks: [], selectedKeys: ["suggestion-selected", "suggestion-blocked"], disabled: false, onSelectionChange: vi.fn() }));
    expect(html).toContain("最近核对错误，先巩固这一步");
    expect(html).not.toContain("旧原因");
    expect(html).toContain("原有原因");
    expect(html).toContain("不会创建");
    expect(html).toContain("今天放不下");
    expect(html).toContain("没有足够长的连续空档");
    expect(html).toMatch(/aria-checked="false" disabled=""/);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain("安排策略：adaptive-1");
    expect(html).not.toContain("撤销");
  });
});
