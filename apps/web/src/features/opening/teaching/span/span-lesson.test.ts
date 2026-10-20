import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SpanLesson } from "./span-lesson";
it.each(["self_study", "overview", "challenge"] as const)("opens new evidence at the actual reserved step for %s", purpose => {
  const html = renderToStaticMarkup(createElement(SpanLesson, {
    courseId: "11111111-1111-4111-8111-111111111111", sourceIds: [], sourceLoadError: true,
    initialIntent: { purpose, timeBudgetMinutes: 15, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" },
    initialNewEvidenceEventId: "22222222-2222-4222-8222-222222222222",
  }));
  expect(html).toContain("离开示范，用服务器发放的保留题检查");
  expect(html).not.toContain("本步骤通过，进入下一道新题");
});
