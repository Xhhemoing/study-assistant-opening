const diagnostics = vi.hoisted(() => ({ enabled: true }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => diagnostics.enabled }));
import type { ExamAttemptView, ExamSprintOverview } from "@aistudy/contracts";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActiveRun, AttemptFeedback, CompletedRun } from "./active-run";
import { filterSources, SourceTracker } from "./source-tracker";
import { hasSprintAttemptHelp, practiceModeForDueAt } from "./labels";
import { LessonButton } from "./lesson-button";
import { SkillsAndLessons } from "./learning-plan";

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
    lessonContents: [], attempts: [attempt], activeRun: run, currentAttempt: attempt, skills: [], summary: { sourceTotal: 2, sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0, onlineAnswered: 0, onlineIndependentCorrect: 0 }, recommendations: [],
    workload: { remainingItems: 2, estimatedMinutes: null, availableMinutes: null, overloaded: false, message: "未设置考试日期" },
  };
}

function clickTarget(node: ReactNode, id: string): { onClick?: (event: { preventDefault: () => void }) => void } | null {
  if (Array.isArray(node)) {
    for (const child of node) { const found = clickTarget(child, id); if (found) return found; }
    return null;
  }
  if (!isValidElement<{ id?: string; children?: ReactNode; onClick?: (event: { preventDefault: () => void }) => void }>(node)) return null;
  return node.props.id === id ? node.props : clickTarget(node.props.children, id);
}

describe("exam sprint UI boundaries", () => {
  const lesson = { id: "lesson-1", topicId: "topic-1", title: "极限串讲", summary: "方法摘要", steps: ["先化简"], workedExample: "完整例题正文不能预先显示", pitfalls: [] };
  const metadata = { id: lesson.id, topicId: lesson.topicId, title: lesson.title, summary: lesson.summary, exposureIdentity: { packVersion: "1", contentFingerprint: "reviewed-content", mappingVersion: "reviewed-map" } };

  it.each(["legacy_untracked_source", "unverifiable_source"] as const)("explains %s as unknown evidence without calling it help", kind => {
    const covered = { ...attempt, independent: false, exposureCoverage: { kind, packSourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: 2 } };
    const html = renderToStaticMarkup(createElement(AttemptFeedback, { attempt: covered, disabled: false, send: () => undefined }));
    expect(html).toContain("这道题之前可能见过材料，这次不单独计分");
    expect(html).not.toContain("含帮助");
    expect(html).not.toContain("未见题族独立作答");
    expect(hasSprintAttemptHelp(covered)).toBe(false);
  });

  it("prevents a manual summary from opening its native details before the asynchronous request is confirmed", () => {
    const overview = fixture();
    overview.activeRun = null;
    overview.pack.lessons = [metadata];
    overview.lessonContents = [{ exposureId: "already-seen", lesson }];
    const onOpenLesson = vi.fn(async () => undefined);
    const send = vi.fn();
    const props = { overview, disabled: false, send, onOpenLesson };
    const summary = clickTarget(SkillsAndLessons(props), "sprint-manual-lesson-1");
    const preventDefault = vi.fn();
    expect(summary?.onClick).toBeDefined();
    summary!.onClick!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onOpenLesson).toHaveBeenCalledExactlyOnceWith(lesson.id, { id: "sprint-manual-lesson-1", label: "返回串讲目录" });
    expect(send).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(createElement(SkillsAndLessons, props))).not.toContain(lesson.workedExample);
  });

  it("labels same-run lesson assistance while keeping previously seen examples separate", () => {
    const assisted = { ...attempt, independent: false, lessonExposureIds: ["lesson-exposure-1"] };
    const seenEarlier = { ...attempt, independent: false, seenExampleExposureIds: ["older-example"] };
    expect(hasSprintAttemptHelp(assisted)).toBe(true);
    expect(hasSprintAttemptHelp(seenEarlier)).toBe(false);
    const html = renderToStaticMarkup(createElement(AttemptFeedback, { attempt: assisted, disabled: false, send: () => undefined }));
    expect(html).toContain("含帮助，不计独立正确");
    const previous = renderToStaticMarkup(createElement(AttemptFeedback, { attempt: seenEarlier, disabled: false, send: () => undefined }));
    expect(previous).not.toContain("含帮助");
  });

  it("shows confirmed partial answers as help even when unrelated source coverage is unknown", () => {
    const partial = { ...attempt, independent: false, partialExampleExposureIds: ["partial-answer"],
      exposureCoverage: { kind: "unverifiable_source" as const, packSourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: 1 } };
    expect(hasSprintAttemptHelp(partial)).toBe(true);
    const html = renderToStaticMarkup(createElement(AttemptFeedback, { attempt: partial, disabled: false, send: () => undefined }));
    expect(html).toContain("含帮助，不计独立正确");
    expect(html).not.toContain("未见题族独立作答");
    expect(html).not.toContain("这道题之前可能见过材料");
  });

  it("offers an exact lesson button and stable original-question target after a mock is submitted", () => {
    const overview = fixture();
    overview.activeRun = null;
    overview.currentAttempt = null;
    overview.state.runs[0]!.completedAt = "2026-10-17T10:10:00Z";
    overview.pack.lessons = [metadata];
    const html = renderToStaticMarkup(createElement(CompletedRun, { overview, disabled: false, send: () => undefined, onOpenLesson: async () => undefined }));
    expect(html).toContain('id="sprint-attempt-attempt-1"');
    expect(html).toContain("查看对应串讲");
    expect(html).toContain("你的答案：A");
    expect(html).toContain(attempt.feedback!.explanation);
    overview.activeRun = fixture().activeRun;
    const activeHtml = renderToStaticMarkup(createElement(CompletedRun, { overview, disabled: false, send: () => undefined, onOpenLesson: () => undefined }));
    expect(activeHtml).toContain("短模拟交卷后才能阅读串讲");
    expect(activeHtml.match(/<button[^>]*>查看对应串讲<\/button>/)?.[0]).toMatch(/\sdisabled(?:=|[ >])/);
  });

  it("keeps lesson actions keyboard-operable and disables missing or ambiguous mappings", () => {
    const overview = fixture();
    overview.activeRun = null;
    overview.pack.lessons = [metadata];
    const props = { overview, lessonId: lesson.id, onOpenLesson: async () => undefined, returnTarget: { id: "original", label: "返回原题" } };
    const html = renderToStaticMarkup(createElement(LessonButton, props));
    expect(html).toContain('type="button"');
    expect(html).not.toMatch(/\sdisabled(?:=|[ >])/);
    for (const lessonId of [null, "gone"]) {
      const missing = renderToStaticMarkup(createElement(LessonButton, { ...props, lessonId }));
      expect(missing).toMatch(/\sdisabled(?:=|[ >])/);
      expect(missing).toContain("暂无对应串讲");
    }
    overview.pack.lessons = [metadata, { ...metadata }];
    expect(renderToStaticMarkup(createElement(LessonButton, props))).toContain("暂无对应串讲");
  });

  it("requires confirmation for skill and manual entries and seals cached content during an active mock", () => {
    const overview = fixture();
    overview.activeRun = null;
    overview.pack.lessons = [metadata];
    overview.skills = [{ skillId: "skill-1", topicId: "topic-1", title: "极限", status: "weak", independentCorrect: 0, attempted: 1, dueAt: null, reason: "需要再练", lessonId: lesson.id }];
    const props = { overview, disabled: false, send: () => undefined, onOpenLesson: () => undefined };
    const html = renderToStaticMarkup(createElement(SkillsAndLessons, props));
    expect(html).toContain('id="sprint-skill-skill-1"');
    expect(html).toContain('id="sprint-lessons-title" tabindex="-1"');
    expect(html).toContain('id="lesson-lesson-1"');
    expect(html).not.toContain('href="#lesson-lesson-1"');
    expect(html).not.toContain(lesson.workedExample);
    overview.lessonContents = [{ exposureId: "exposure-1", lesson }];
    expect(renderToStaticMarkup(createElement(SkillsAndLessons, props))).not.toContain(lesson.workedExample);
    const confirmed = renderToStaticMarkup(createElement(SkillsAndLessons, { ...props, lessonContent: overview.lessonContents[0] }));
    expect(confirmed).toContain(lesson.workedExample);
    expect(confirmed).toContain(' open=""');
    overview.activeRun = fixture().activeRun;
    const sealed = renderToStaticMarkup(createElement(SkillsAndLessons, { ...props, lessonContent: overview.lessonContents[0] }));
    expect(sealed).not.toContain('href="#lesson-lesson-1"');
    expect(sealed).not.toContain(lesson.workedExample);
    expect(sealed).toContain("短模拟交卷后才能阅读串讲");
  });

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
    overview.state.runs[0]!.completedAt = "2026-10-17T10:10:00Z";
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

  it("encourages help and hides measurement bookkeeping in the student view", () => {
    diagnostics.enabled = false;
    try {
      const overview = fixture();
      overview.activeRun!.mode = "practice";
      overview.currentAttempt = { ...attempt, answer: null, answeredAt: null, feedback: null };
      const html = renderToStaticMarkup(createElement(ActiveRun, { overview, disabled: false, send() {} }));
      expect(html).toContain("卡住了就看提示");
      expect(html).not.toMatch(/不计独立|题族|曝光|记录的使用条件变化|资格/);
      overview.activeRun = null; overview.state.runs[0]!.completedAt = "2026-10-21T00:00:00Z";
      expect(renderToStaticMarkup(createElement(CompletedRun, { overview, disabled: false, send() {} }))).not.toMatch(/不计独立|题族|曝光|记录的使用条件变化|资格/);
    } finally { diagnostics.enabled = true; }
  });

  it("distinguishes repeated question-family evidence from using help", () => {
    const repeated = { ...attempt, independent: false };
    const html = renderToStaticMarkup(createElement(AttemptFeedback, { attempt: repeated, disabled: false, send: () => undefined }));
    expect(html).toContain("本次暂不计入新的独立作答依据（重复练习、使用过帮助或记录的使用条件变化）");
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
