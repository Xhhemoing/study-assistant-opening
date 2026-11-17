// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExamMode, ExamSprintOverview } from "@aistudy/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActiveRun } from "./active-run";

vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));

function fixture(mode: ExamMode): ExamSprintOverview {
  const run = { id: "current-run", mode, questionIds: ["q1", "q2"], startedAt: new Date().toISOString(), deadlineAt: null, completedAt: null };
  const attempt = { id: "pending", runId: run.id, questionId: "q1", presentedAt: run.startedAt, answeredAt: null,
    answer: null, correct: null, confidence: null, durationSeconds: null, help: [], errorCause: null, independent: false, hint: null, feedback: null,
    question: { id: "q1", topicId: "topic", skillId: "skill", lessonId: "lesson", familyId: "family", difficulty: "foundation" as const,
      prompt: "待回答题", options: [{ id: "A", label: "选项" }], estimatedMinutes: 1 } };
  return { pack: { id: "pack", version: "1", title: "冲刺", description: "", topics: [], lessons: [], sourceItems: [], weekPlan: [], limitations: [] },
    state: { version: 1, startedAt: run.startedAt, examDate: null, dailyMinutes: 60, runs: [run], sourceRecords: [] },
    activeRun: run, currentAttempt: attempt, attempts: [attempt], lessonContents: [], skills: [], recommendations: [],
    summary: { sourceTotal: 0, sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0, onlineAnswered: 0, onlineIndependentCorrect: 0 },
    workload: { remainingItems: 0, estimatedMinutes: null, availableMinutes: null, overloaded: false, message: "" } };
}

let host: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (label: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === label)!;

it.each([ ["practice", "取消本轮练习"], ["mock-a", "取消模拟"] ] as const)("confirms cancellation of %s and sends only finish for the current run", async (mode, label) => {
  const overview = fixture(mode), send = vi.fn();
  await act(async () => root.render(createElement(ActiveRun, { overview, disabled: false, send })));
  expect(button(label)).toBeDefined();
  await act(async () => button(label).click());
  expect(send).not.toHaveBeenCalled();
  const confirmation = host.querySelector('[role="group"][aria-label="确认取消本轮"]');
  expect(confirmation).not.toBeNull();
  expect(confirmation!.textContent).toContain("保留已提交答案");
  expect(confirmation!.textContent).toContain("未答题保持未答");
  if (mode === "mock-a") expect(confirmation!.textContent).toContain("不能重新开启");
  await act(async () => button("继续作答").click());
  expect(host.querySelector('[aria-label="确认取消本轮"]')).toBeNull();
  expect(send).not.toHaveBeenCalled();
  expect(host.textContent).toContain("待回答题");
  await act(async () => button(label).click());
  await act(async () => button("确认结束本轮").click());
  expect(send).toHaveBeenCalledExactlyOnceWith({ action: "finish", runId: "current-run" });
  expect(overview.currentAttempt!.answeredAt).toBeNull();
  expect(overview.currentAttempt!.answer).toBeNull();
});

it("locks cancellation and its confirmation while the client is resolving an operation", async () => {
  const overview = fixture("mock-a"), send = vi.fn();
  await act(async () => root.render(createElement(ActiveRun, { overview, disabled: false, send })));
  await act(async () => button("取消模拟").click());
  await act(async () => root.render(createElement(ActiveRun, { overview, disabled: true, send })));
  expect(button("取消模拟").disabled).toBe(true);
  expect(button("确认结束本轮").disabled).toBe(true);
  await act(async () => button("确认结束本轮").click());
  expect(send).not.toHaveBeenCalled();
});
