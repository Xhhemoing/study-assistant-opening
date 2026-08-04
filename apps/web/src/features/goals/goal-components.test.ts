import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { GoalDetail, createGoalRequestGuard } from "./goal-detail";
import { GoalList } from "./goal-list";
import { GoalWizard } from "./goal-wizard";

describe("goal surfaces", () => {
  it("renders the goal list entry point", () => {
    const html = renderToStaticMarkup(createElement(GoalList));
    expect(html).toContain("学习目标");
    expect(html).toContain("创建目标");
  });

  it("starts the wizard at scenario selection and exposes skip", () => {
    const html = renderToStaticMarkup(createElement(GoalWizard));
    expect(html).toContain("创建学习目标");
    expect(html).toContain("选择目标场景");
    expect(html).toContain("跳过");
    expect(html).toContain("下一步");
  });

  it("renders a stable detail surface while goal data is loading", () => {
    const html = renderToStaticMarkup(createElement(GoalDetail, { id: "goal-1" }));
    expect(html).toContain("目标详情");
    expect(html).toContain("正在读取目标");
  });

  it("ignores an older goal response after the id changes", () => {
    const guard = createGoalRequestGuard();
    guard.mount();
    const oldRequest = guard.start();
    const currentRequest = guard.start();

    expect(guard.canApply(oldRequest)).toBe(false);
    expect(guard.canApply(currentRequest)).toBe(true);
  });

  it("ignores a goal response that completes after unmount", () => {
    const guard = createGoalRequestGuard();
    guard.mount();
    const request = guard.start();
    guard.unmount();

    expect(guard.canApply(request)).toBe(false);
  });
});
