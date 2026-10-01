import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { summarizeObservations } from "@aistudy/domain";
import type { LearningSummary } from "@aistudy/contracts";
import { courseEvidence, learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { CourseLearningRecords, CourseSummaryNotice } from "./course-view";
import { emptyCourseSummary } from "./course-summary-state";

const evidence = courseEvidence();
const summary = summarizeObservations(evidence.observations, learningObservation.occurredAt, { evidenceContexts: evidence.evidenceContexts });
const props = { courseId: learningObservation.courseId!, error: "读取暂不可用", summary, onReload: () => undefined };

describe("course learning records", () => {
  it.each(["loading", "error"] as const)("does not display stale evidence or a false empty result during %s", (state) => {
    const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state }));
    expect(html).not.toContain("fractions");
    expect(html).not.toContain("目前没有生效");
    if (state === "error") expect(html).toContain("重新读取");
    else expect(html).toContain('role="status"');
  });

  it("keeps source, eligibility and paginated history behind progressive disclosure", () => {
    const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready" }));
    expect(html).toContain("fractions");
    expect(html).toContain("记录为参考核对（资格另列）");
    expect(html).toContain("本次独立作答");
    expect(html).toContain("有依据的参考核验");
    expect(html).toContain("按固定快照翻阅");
    expect(html).toContain("刷新历史（新快照）");
    expect(html).not.toContain(" open=");
  });

  it("keeps missing qualification information pending even when a summary exists", () => {
    const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: summary.map((item) => ({ ...item, evidenceEligibility: [] })) }));
    expect(html).toContain("资格信息尚未提供，保留待核验");
  });

  it("reports empty evidence only after a successful read", () => {
    const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: [] }));
    expect(html).toContain("目前没有生效的学习观察");
    expect(html).not.toContain("读取暂不可用");
  });
});

it("offers an explicit refresh after projection repair stops without progress", () => {
  const state = { ...emptyCourseSummary(), status: "updating" as const, pendingProjectionCount: 4, notice: "资格更新暂未推进，请手动刷新摘要。" };
  const html = renderToStaticMarkup(createElement(CourseSummaryNotice, { state, onRefresh: () => undefined }));
  expect(html).toContain("资格更新暂未推进，请手动刷新摘要");
  expect(html).toContain("刷新摘要");
});

it("shows the latest result and an actionable next step before historical evidence", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: summary.map((item): LearningSummary => ({
    ...item, recentPerformance: { status: "observed_independent", evidenceIds: item.evidenceIds }, historicalIncorrectCount: 2, unverifiedCount: 1,
  })) }));
  const result = html.slice(0, html.indexOf("<details"));
  expect(result).toContain("最近观察到独立完成");
  expect(result).toContain("换一道题独立完成，继续确认");
  expect(result).toContain('href="#course-practice"');
  expect(result).not.toContain("核验错误");
  expect(html).toContain("更早的记录中有 2 条核验错误");
  expect(html).toContain("1 条记录尚未核验");
  expect(html).not.toContain(" open=");
});

it("keeps due review visible alongside the latest independent performance", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: summary.map((item): LearningSummary => ({
    ...item, status: "needs_review", recentPerformance: { status: "observed_independent", evidenceIds: item.evidenceIds },
  })) }));
  const result = html.slice(0, html.indexOf("<details"));
  expect(result).toContain("需要复习");
  expect(result).toContain("近期已有独立完成观察");
  expect(result).toContain("仍需完成到期复习");
});

it("does not hide a latest unresolved result behind a previous success", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: summary.map((item): LearningSummary => ({
    ...item, status: "needs_check", recentPerformance: { status: "needs_check", evidenceIds: item.evidenceIds },
  })) }));
  const result = html.slice(0, html.indexOf("<details"));
  expect(result).toContain("最近一次需要核验");
  expect(result).toContain("先查看来源与资格，确认记录后再继续练习");
  expect(result).not.toContain("最近观察到独立完成");
});

it("distinguishes the full recent count from representative evidence details", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: summary.map((item): LearningSummary => ({
    ...item, sampleCount: 201, recentPerformance: { status: "observed_independent", evidenceIds: item.evidenceIds, evidenceCount: 201 },
  })) }));
  expect(html).toContain("201 条观察");
  expect(html).toContain("近期结果依据最近的 201 条原始作答");
  expect(html).toContain("1 条代表证据");
  expect(html).toContain("最近代表观察 1");
  expect(html).toContain('href="#course-practice"');
});

it("uses the original recent ID count for a legacy response", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: summary.map((item): LearningSummary => ({
    ...item, recentPerformance: { status: "observed_independent", evidenceIds: item.evidenceIds },
  })) }));
  expect(html).toContain("近期结果依据最近的 1 条原始作答");
});

it("offers fixed-snapshot history controls instead of rendering the former full observation response", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready" }));
  expect(html).toContain("按固定快照翻阅");
  expect(html).toContain("刷新历史（新快照）");
});
