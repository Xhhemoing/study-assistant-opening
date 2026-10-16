import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { PlanFeedbackSummary } from "@aistudy/contracts";
import { PlanFeedbackReadout } from "./plan-feedback-panel";

it("shows an empty denominator as no sample and keeps action counts distinct from learning outcomes", () => {
  const summary: PlanFeedbackSummary = { from: "2026-10-09T12:00:00.000Z", until: "2026-10-16T12:00:00.000Z",
    actions: { done: 0, skipped: 0, deferred: 0, resumed: 1 },
    reasons: { eligible: 0, supplied: 0, declined: 0, missing: 0, coverage: null,
      counts: { time_short: 0, too_hard: 0, too_easy: 0, not_relevant: 0, other: 0 } }, historicalActions: "unknown" };
  const html = renderToStaticMarkup(createElement(PlanFeedbackReadout, { summary }));
  expect(html).toContain("尚无可统计样本");
  expect(html).toContain("取消推迟");
  expect(html).toContain("更早的历史未知");
  expect(html).toContain("操作次数不能代表学习效果");
  expect(html).not.toContain("填写率 0%");
});
