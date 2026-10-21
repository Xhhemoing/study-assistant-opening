// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { OpeningApi } from "../client/api";
import { TodayStudyTools } from "./today-study-tools";

it("does not mount optional tools or read their data until the disclosure is opened", () => {
  function ExpensiveChild(): never { throw new Error("closed tools mounted their children"); }
  const html = renderToStaticMarkup(createElement(TodayStudyTools, {
    api: {} as OpeningApi, date: "2026-10-10", plan: null, tasks: [], onChanged: () => {},
    children: createElement(ExpensiveChild),
  }));
  expect(html).toContain("更多排程与提醒");
  expect(html).not.toContain("正在读取提醒");
  expect(html).not.toContain("生成建议计划");
});

it("offers an actionable priority control when the queue can be hidden on mobile", async () => {
  const { TodayLearningContext } = await import("./today-overview");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), onShowActions = vi.fn();
  try {
    await act(async () => root.render(createElement(TodayLearningContext, { onShowActions })));
    const actions = container.querySelector('nav[aria-label="学习闭环快捷入口"]');
    const priority = actions?.querySelector("button");
    expect(priority?.textContent).toBe("优先行动");
    expect(priority?.type).toBe("button");
    expect(container.querySelector('a[href="#action-digest"]')).toBeNull();
    expect(container.querySelector('a[href="/opening/courses"]')).not.toBeNull();
    await act(async () => priority!.click());
    expect(onShowActions).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
