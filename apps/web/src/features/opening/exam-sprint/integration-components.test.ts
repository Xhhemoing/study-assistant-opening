const diagnostics = vi.hoisted(() => ({ enabled: true }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => diagnostics.enabled }));
import type { ExamForecastOverview, ExamIntegrationOverview, ExamSprintOverview, ExamWorkReview } from "@aistudy/contracts";
import { createElement, isValidElement, type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BktPanel } from "./bkt-panel";
import { ForecastResults } from "./forecast-panel";
import { integrationSchema } from "./client-schemas";
import { EvidenceLinks } from "./integration-panel";
import { WeekPlan } from "./learning-plan";
import { WorkReviewPanel, WorkReviewResult, matchingWorkReview, type WorkReviewContext } from "./work-review-panel";

const overview = { skills: [{ skillId: "skill-1", title: "分部积分" }] } as ExamSprintOverview;
const integration: ExamIntegrationOverview = { binding: null, links: [], bkt: { calibrated: false, eligible: 2, excluded: 3, bktBrier: 0.24, baselineBrier: 0.25, message: "样本有限", skills: [{ skillId: "skill-1", eligible: 2, nextCorrectProbability: 0.8 }] }, courseGoal: null, sourceMappings: [] };
const forecast: ExamForecastOverview = { teacher: "老师 A", papers: [], topics: [{ skillId: "skill-1", examinedPapers: 0, totalPapers: 0, probability: 0.8, lower: 0.1, upper: 0.9, meanPoints: null }], status: "no_history", message: "尚无历史真卷" };

describe("exam integration evidence presentation", () => {
  it("hides standalone workload estimates when course planning owns the budget", () => {
    const data = { ...overview, pack: { weekPlan: [{ day: 1, minutes: 360, title: "诊断", tasks: ["先尝试"] }] }, workload: { overloaded: true, message: "旧冲刺预算超载", estimatedMinutes: 999, availableMinutes: 10 } } as ExamSprintOverview;
    const html = renderToStaticMarkup(createElement(WeekPlan, { overview: data, bound: true }));
    expect(html).toContain("实际任务与总时间预算使用课程规划");
    expect(html).not.toContain("旧冲刺预算超载");
    expect(html).not.toContain("剩余预算");
    expect(html).not.toContain("999");
  });

  it("clears a previous human confirmation before requesting a new image review", () => {
    const sent: unknown[] = [];
    const drafts: unknown[] = [];
    const context = { integration: { ...integration, binding: { materials: [{ sourceTitle: "原卷", sourceId: "ref-1", sourceVersion: 3 }] } }, resources: { sources: [{ id: "photo-1", mime: "image/png", name: "解答照片", version: 2 }] }, review: null, send: (value: unknown) => sent.push(value), refresh: () => undefined } as WorkReviewContext;
    const tree = WorkReviewPanel({ source: { id: "item", topicId: "topic", label: "Q1", sourceTitle: "原卷", sourcePage: 4, kind: "choice", suggestedDay: 1, skills: [] }, context, draft: { workSourceId: "photo-1", answerText: "解答", referenceChecked: true }, onChange: value => drafts.push(value), disabled: false });
    type Props = { children?: ReactNode; onClick?: () => void };
    function button(node: ReactNode): ReactElement<Props> | undefined {
      if (Array.isArray(node)) return node.map(button).find(Boolean);
      if (!isValidElement<Props>(node)) return;
      if (node.type === "button" && node.props.children === "请求 AI 过程点评") return node;
      return button(node.props.children);
    }
    button(tree)?.props.onClick?.();
    expect(drafts).toEqual([{ workSourceId: "photo-1", answerText: "解答", referenceChecked: false }]);
    expect(sent).toEqual([{ action: "review", input: { sourceItemId: "item", workSourceId: "photo-1", workSourceVersion: 2, referenceSourceId: "ref-1", referenceSourceVersion: 3, answerText: "解答" } }]);
  });

  it("does not show a topic percentage without historical real papers", () => {
    const html = renderToStaticMarkup(createElement(ForecastResults, { overview, forecast }));
    expect(html).toContain("没有可用真卷");
    expect(html).not.toMatch(/\d+%/);
  });

  it("shows historical interval together with the sample denominator", () => {
    const result: ExamForecastOverview = { ...forecast, status: "limited_history", topics: [{ ...forecast.topics[0], examinedPapers: 1, totalPapers: 2, meanPoints: 8 }], papers: [{ id: "paper", courseId: "course", sourceId: "source", sourceVersion: 1, teacher: "老师 A", year: 2025, label: "期末", kind: "past_exam", skills: [{ skillId: "skill-1", points: 8 }], recordedAt: "2026-10-17T00:00:00Z" }] };
    const html = renderToStaticMarkup(createElement(ForecastResults, { overview, forecast: result }));
    expect(html).toContain("1 / 2");
    expect(html).toContain("10%–90%");
    expect(html).toContain("不能保证下一次考试");
    expect(html).toContain("version=1");
  });

  it("keeps model probabilities out of the student view", () => {
    diagnostics.enabled = false;
    expect(renderToStaticMarkup(createElement(BktPanel, { integration, overview }))).toBe("");
    diagnostics.enabled = true;
  });
  it("labels model probabilities as uncalibrated next-answer estimates rather than mastery", () => {
    const html = renderToStaticMarkup(createElement(BktPanel, { integration, overview }));
    expect(html).toContain("下一题表现估计 · 未校准");
    expect(html).toContain("不是掌握百分比");
    expect(html).toContain("下题独立答对估计 80%");
    expect(html).toContain("有效样本 2");
    expect(html).toContain("0.240");
  });

  it("shows only publication status for a mock evidence link", () => {
    const state = { ...integration, links: [{ examAttemptId: "mock-a1", learningAttemptId: "learning-1", observationId: null, nodeId: "node-1", requirementKey: "r-1", publication: "pending_mock" as const }] };
    const html = renderToStaticMarkup(createElement(EvidenceLinks, { integration: state }));
    expect(html).toContain("等待模拟交卷");
    expect(html).toContain("已关联 0 次");
    expect(html).not.toContain("回答正确");
  });

  it("accepts unavailable source evidence and never counts it as waiting for completion", () => {
    const state = { ...integration, links: [{ examAttemptId: "mock-a1", learningAttemptId: "learning-1", observationId: null, nodeId: "node-1", requirementKey: "r-1", publication: "unavailable" as const }] };
    const parsed = integrationSchema.parse(state);
    expect(parsed.links[0].publication).toBe("unavailable");
    const html = renderToStaticMarkup(createElement(EvidenceLinks, { integration: parsed }));
    expect(html).toContain("已保存答案，材料或技能身份待核对，未计入正式证据");
    expect(html).toContain("已关联 0 次 · 未提交/未作答 0 次 · 材料或技能待核对 1 次");
    expect(html).toContain("不会把旧成绩转给新技能");
    expect(html).not.toContain("等待模拟交卷");
    expect(html).not.toContain("尚无作答记录");
  });

  it("keeps a positive AI work review as an unaccepted candidate", () => {
    const review: ExamWorkReview = { id: "review", sourceItemId: "item", workSourceId: "work", referenceSourceId: "ref", workSourceVersion: 2, referenceSourceVersion: 3, answerText: "原解答", createdAt: "2026-10-17T00:00:00Z", status: "ready", modelLabel: "configured model", proposal: { transcription: "学生过程", questionMatch: true, outcome: "correct", steps: [{ label: "第一步", verdict: "correct", feedback: "选法合理" }], summary: "建议对照原卷核对", errorCause: null } };
    const html = renderToStaticMarkup(createElement(WorkReviewResult, { review }));
    expect(html).toContain("候选：完整正确 · 待你核对");
    expect(html).toContain("不会自动改写你的自评或掌握状态");
    expect(html).not.toContain("自动接受");
    expect(matchingWorkReview(review, "item", { id: "work", version: 2 }, { sourceId: "ref", sourceVersion: 3 }, " 原解答 ")).toBe(review);
    expect(matchingWorkReview(review, "item", { id: "work", version: 3 }, { sourceId: "ref", sourceVersion: 3 }, "原解答")).toBeNull();
    expect(matchingWorkReview(review, "item", { id: "work", version: 2 }, { sourceId: "ref", sourceVersion: 4 }, "原解答")).toBeNull();
    expect(matchingWorkReview(review, "item", { id: "work", version: 2 }, { sourceId: "ref", sourceVersion: 3 }, "已改答案")).toBeNull();
  });
});
