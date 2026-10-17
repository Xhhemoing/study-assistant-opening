import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { buildLoopMetricsReport } from "@aistudy/domain";
import { LoopMetricsReadout } from "./loop-metrics-panel";

it("shows three groups with unavailable data, sample counts and no invented zero performance", () => {
  const report = buildLoopMetricsReport({ asOf: "2026-10-16T16:00:00.000Z", windowStart: "2026-10-03T07:00:00.000Z", windowDays: 14,
    timeZone: "America/Los_Angeles", jobs: [], budget: [], observations: [], learningComplete: true, privacyExcludedCount: 0,
    feedback: { from: "2026-10-03T07:00:00.000Z", until: "2026-10-16T16:00:00.000Z", historicalActions: "unknown",
      actions: { done: 0, skipped: 0, deferred: 0, resumed: 0 }, reasons: { eligible: 0, supplied: 0, missing: 0, declined: 0, coverage: null,
        counts: { time_short: 0, too_hard: 0, too_easy: 0, not_relevant: 0, other: 0 } } },
    suggestions: { complete: true, generated: 0, accepted: 0, minutes: 0 } });
  const html = renderToStaticMarkup(createElement(LoopMetricsReadout, { report }));
  for (const text of ["运行可靠性", "学习结果", "负担与控制", "尚无样本", "尚未采集", "样本 0", "America/Los_Angeles", "含未展示草案"]) expect(html).toContain(text);
  expect(html).not.toContain("0%");
  expect(html).not.toContain("掌握率");
});
