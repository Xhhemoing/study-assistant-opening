import type { ExamAttemptView, ExamSprintOverview } from "@aistudy/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveRun, AttemptFeedback, CompletedRun } from "./active-run";
import { filterSources, SourceTracker } from "./source-tracker";
import { practiceModeForDueAt } from "./labels";

const attempt: ExamAttemptView = {
  id: "attempt-1", runId: "run-1", questionId: "q-1", presentedAt: "2026-10-17T10:00:00Z", answeredAt: "2026-10-17T10:01:00Z",
  answer: "A", correct: false, confidence: 3, durationSeconds: 60, help: [], errorCause: null, independent: true,
  question: { id: "q-1", topicId: "topic-1", skillId: "skill-1", familyId: "family-1", lessonId: "lesson-1", difficulty: "foundation", prompt: "计算这个极限", options: [{ id: "A", label: "0" }, { id: "B", label: "1" }], estimatedMinutes: 2 },
  feedback: { answer: "B", explanation: "这是只允许在交卷后出现的解析" }, hint: "这是不应在模拟时出现的提示",
};
function fixture(): ExamSprintOverview {
  const run = { id: "run-1", mode: "mock-a" as const, questionIds: ["q-1", "q-2"], startedAt: "2026-10-17T10:00:00Z", deadlineAt: "2026-10-17T10:30:00Z", completedAt: null };
  return {
    pack: { id: "test", version: "1", title: "数学冲刺", description: "预置学习包", topics: [{ id: "topic-1", title: "极限" }, { id: "topic-2", title: "积分" }], lessons: [], sourceItems: [
      { id: "source-1", topicId: "topic-1", label: "Q9", sourceTitle: "Topic 2 课件", sourcePage: 43, kind: "choice", suggestedDay: 2, skills: ["严格极限"] },
      { id: "source-2", topicId: "topic-2", label: "Problem 9", sourceTitle: "Topic 4 积分参考题", sourcePage: 12, kind: "problem", suggestedDay: 4, skills: ["分部积分"] },
    ], weekPlan: [], limitations: [] },
    state: { version: 1, startedAt: run.startedAt, examDate: null, dailyMinutes: 360, runs: [run], sourceRecords: [] },
    attempts: [attempt], activeRun: run, currentAttempt: attempt, skills: [], summary: { sourceTotal: 2, sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0, onlineAnswered: 0, onlineIndependentCorrect: 0 }, recommendations: [],
    workload: { remainingItems: 2, estimatedMinutes: null, availableMinutes: null, overloaded: false, message: "未设置考试日期" },
  };
}

describe("exam sprint UI boundaries", () => {
  it("keeps newly scheduled skills in practice until the retest actually becomes due", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    expect(practiceModeForDueAt("2026-10-18T12:00:00Z", now)).toBe("practice");
    expect(practiceModeForDueAt(null, now)).toBe("practice");
    expect(practiceModeForDueAt("2026-10-17T12:00:00Z", now)).toBe("retest");
  });

  it("keeps feedback and help out of an active mock even if present in supplied props", () => {
    const html = renderToStaticMarkup(createElement(ActiveRun, { overview: fixture(), disabled: false, send: () => undefined }));
    expect(html).toContain("计算这个极限");
    expect(html).toContain("交卷后统一查看解析");
    expect(html).not.toContain(attempt.feedback!.explanation);
    expect(html).not.toContain(attempt.hint);
    expect(html).not.toContain("给我提示");
    expect(html).toContain("不是完整考试卷");
  });

  it("allows external-help audit before a mock answer while keeping hints and solutions sealed", () => {
    const data = fixture();
    data.currentAttempt = { ...attempt, answeredAt: null, answer: null, correct: null, independent: false };
    data.attempts = [data.currentAttempt];
    data.activeRun!.deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const html = renderToStaticMarkup(createElement(ActiveRun, { overview: data, disabled: false, send: () => undefined }));
    const externalButton = html.match(/<button[^>]*>已用外部帮助<\/button>/)?.[0];
    expect(externalButton).toBeDefined();
    expect(externalButton).not.toMatch(/\sdisabled(?:=|[ >])/);
    expect(html).not.toContain("给我提示");
    expect(html).not.toContain("直接看答案");
    expect(html).not.toContain(attempt.feedback!.explanation);
    expect(html).not.toContain(attempt.hint);
  });

  it("shows completed mock feedback and counts unanswered questions without inventing attempts", () => {
    const overview = fixture();
    overview.activeRun = null;
    overview.currentAttempt = null;
    overview.attempts = [{ ...attempt, correct: true, independent: false }];
    overview.state.runs[0].completedAt = "2026-10-17T10:10:00Z";
    const html = renderToStaticMarkup(createElement(CompletedRun, { overview, disabled: false, send: () => undefined }));
    expect(html).toContain("已答 1/2");
    expect(html).toContain("A. 0");
    expect(html).toContain("B. 1");
    expect(html).toContain("你的选择");
    expect(html).toContain("客观题正确 1 / 2 · 未答 1 · 独立新题族正确 0");
    expect(html).toContain(attempt.feedback!.explanation);
    expect(html).toContain("不代表正式考试分数");
  });

  it("does not describe a viewed solution as independent mastery", () => {
    const helped = { ...attempt, answer: null, answeredAt: null, independent: false, help: [{ kind: "solution" as const, at: attempt.presentedAt }] };
    const html = renderToStaticMarkup(createElement(AttemptFeedback, { attempt: helped, disabled: false, send: () => undefined }));
    expect(html).toContain("未作答");
    expect(html).toContain("含帮助，不计独立正确");
    expect(html).not.toContain("这次卡在哪里");
  });

  it("distinguishes repeated question-family evidence from using help", () => {
    const repeated = { ...attempt, independent: false };
    const html = renderToStaticMarkup(createElement(AttemptFeedback, { attempt: repeated, disabled: false, send: () => undefined }));
    expect(html).toContain("当前不计新增独立证据（重复、帮助或资格变化）");
    expect(html).not.toContain("含帮助");
  });

  it("filters source indexes by topic and matching title, skill or page", () => {
    const items = fixture().pack.sourceItems;
    expect(filterSources(items, "topic-2", "9").map(item => item.id)).toEqual(["source-2"]);
    expect(filterSources(items, "", " 43 ").map(item => item.id)).toEqual(["source-1"]);
    expect(filterSources(items, "", "严格极限").map(item => item.id)).toEqual(["source-1"]);
    expect(filterSources(items, "topic-1", "积分")).toEqual([]);
  });

  it("shows source records as registered coverage rather than an imported question or mastered skill", () => {
    const overview = fixture();
    overview.state.sourceRecords = [{ id: "record-1", sourceId: "source-1", phase: "first", outcome: "read", assistance: "solution", durationMinutes: 5, errorCause: null, note: "", recordedAt: attempt.presentedAt }];
    const html = renderToStaticMarkup(createElement(SourceTracker, { overview, disabled: false, send: () => undefined }));
    expect(html).toContain("已有登记");
    expect(html).toContain("未登记");
    expect(html).toContain("来源覆盖与在线技能状态分别计算");
    expect(html).not.toContain("已掌握");
  });
});
