import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
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
  const html = renderToStaticMarkup(createElement(TodayLearningContext, { onShowActions: () => {} }));
  expect(html).toContain("优先行动</button>");
  expect(html).not.toContain('href="#action-digest"');
  expect(html).toContain('href="/opening/cards"');
  expect(html).toContain('href="/opening/settings/connections"');
});
