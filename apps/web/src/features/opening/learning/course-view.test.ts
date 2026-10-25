import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeObservations } from "@aistudy/domain";
import type { LearningSummary } from "@aistudy/contracts";
import { courseEvidence, learningObservation, qualifiedInput } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { CourseLearningRecords, CourseSummaryNotice } from "./course-view";
import { emptyCourseSummary } from "./course-summary-state";

const preferences = vi.hoisted(() => ({ diagnostics: true }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => preferences.diagnostics }));
beforeEach(() => { preferences.diagnostics = true; });

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

  it("shows complete eligibility diagnostics and paginated history without nested disclosures", () => {
    const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready" }));
    expect(html).toContain("fractions");
    expect(html).toContain("参考核对记录");
    expect(html).toContain("本次独立作答");
    expect(html).toContain("有依据的参考核对");
    expect(html).toContain("已保存的观察");
    expect(html).toContain("刷新历史");
    expect(html).not.toContain("<details");
  });

  it("keeps a learner reference comparison visible without presenting independently verified success", () => {
    const compared = courseEvidence({
      ...qualifiedInput,
      observation: { ...qualifiedInput.observation, verdictSource: "self_report" },
      context: { ...qualifiedInput.context, referenceCheckAuthority: "learner",
        referenceCheck: { ...qualifiedInput.context.referenceCheck!, method: "learner_self_compare" } },
    });
    compared.observations[0]!.verdictSource = "self_report";
    const comparedSummary = summarizeObservations(compared.observations, learningObservation.occurredAt, { evidenceContexts: compared.evidenceContexts });
    const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: comparedSummary }));
    expect(comparedSummary[0]?.evidenceEligibility[0]?.eligibility.verifiedCorrect).toBe("unknown");
    expect(html).toContain("证据来源：自报");
    expect(html).toContain("学习者自对照参考，尚未经独立评分");
    expect(html).toContain("待确认");
    expect(html).not.toContain("最近观察到独立完成");
  });

  it("keeps missing qualification information pending even when a summary exists", () => {
    const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: summary.map((item) => ({ ...item, evidenceEligibility: [] })) }));
    expect(html).toContain("资格信息尚未提供，先保留");
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
  const result = html.split('aria-label="学习证据诊断"')[0]!;
  expect(result).toContain("最近观察到独立完成");
  expect(result).toContain("换一道题独立完成，继续确认");
  expect(result).toContain('study?mode=practice&amp;skillLabel=fractions&amp;requirementKey=requirement-1');
  expect(result).not.toContain("核验错误");
  expect(html).toContain("更早的记录中有 2 条核对错误");
  expect(html).toContain("1 条记录尚未确认");
  expect(html).not.toContain(" open=");
});

it("keeps due review visible alongside the latest independent performance", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: summary.map((item): LearningSummary => ({
    ...item, status: "needs_review", recentPerformance: { status: "observed_independent", evidenceIds: item.evidenceIds },
  })) }));
  const result = html.split('aria-label="学习证据诊断"')[0]!;
  expect(result).toContain("需要复习");
  expect(result).toContain("近期已有独立完成观察");
  expect(result).toContain("仍需完成到期复习");
});

it("does not hide a latest unresolved result behind a previous success", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: summary.map((item): LearningSummary => ({
    ...item, status: "needs_check", recentPerformance: { status: "needs_check", evidenceIds: item.evidenceIds },
  })) }));
  const result = html.split('aria-label="学习证据诊断"')[0]!;
  expect(result).toContain("最近一次还需确认");
  expect(result).toContain("先查看作答记录，再继续练习核对结果");
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
  expect(html).toContain('study?mode=practice&amp;skillLabel=fractions&amp;requirementKey=requirement-1');
});

it("uses the original recent ID count for a legacy response", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: summary.map((item): LearningSummary => ({
    ...item, recentPerformance: { status: "observed_independent", evidenceIds: item.evidenceIds },
  })) }));
  expect(html).toContain("近期结果依据最近的 1 条原始作答");
});

it("offers fixed-snapshot history controls instead of rendering the former full observation response", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready" }));
  expect(html).toContain("已保存的观察");
  expect(html).toContain("刷新历史");
});

it("shows representative observation identifiers and capture times", () => {
  const observationId = summary[0]?.evidenceIds[0];
  expect(observationId).toBeTruthy();
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready" }));
  expect(html).toContain(observationId!);
  expect(html).toContain("记录时间");
});

it("keeps source authority visible but hides identifiers and eligibility diagnostics by default", () => {
  preferences.diagnostics = false;
  const observationId = summary[0]!.evidenceIds[0]!;
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready" }));
  expect(html).toContain("证据来源：参考核对记录");
  expect(html).toContain("继续独立练习");
  expect(html).toContain("已保存的观察");
  expect(html).not.toContain(observationId);
  expect(html).not.toContain("学习证据诊断");
  expect(html).not.toContain("资格与原因");
  expect(html).not.toContain("<details");
});

it("does not hide self comparison or unavailable-source caveats when diagnostics are off", () => {
  preferences.diagnostics = false;
  const limited = summary.map(item => ({ ...item, evidenceSources: ["self_report" as const], evidenceEligibility: item.evidenceEligibility.map(value => ({ ...value,
    versionApplicability: "unavailable" as const, eligibility: { ...value.eligibility, verifiedCorrect: "unknown" as const,
      reasonCodes: [...value.eligibility.reasonCodes, "learner_reference_compare" as const] },
  })) }));
  const html = renderToStaticMarkup(createElement(CourseLearningRecords, { ...props, state: "ready", summary: limited }));
  expect(html).toContain("证据来源：自报");
  expect(html).toContain("学习者自对照参考，尚未经独立评分");
  expect(html).toContain("部分引用来源已不可用");
  expect(html).not.toContain("观察 ID");
});
