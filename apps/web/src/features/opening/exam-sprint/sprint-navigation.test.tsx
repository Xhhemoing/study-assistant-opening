import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExamIntegrationOverview, ExamSprintOverview } from "@aistudy/contracts";
import { expect, it, vi } from "vitest";
import { ObjectConversationContext } from "../assistant/conversation-object-context";
import { ExamSprintView } from "./sprint-view";

const state = vi.hoisted(() => ({ snapshot: {} }));
vi.mock("./client", () => ({ createExamSprintClient: () => ({ subscribe: () => () => undefined, getSnapshot: () => state.snapshot }) }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
const course = "11111111-1111-4111-8111-111111111111", conversation = "22222222-2222-4222-8222-222222222222";
const overview: ExamSprintOverview = {
  pack: { id: "test", version: "1", title: "数学冲刺", description: "预置题包", topics: [], lessons: [], sourceItems: [], weekPlan: [], limitations: [] },
  state: { version: 1, startedAt: "2026-10-22T08:00:00Z", examDate: null, dailyMinutes: 60, runs: [], sourceRecords: [] },
  lessonContents: [], attempts: [], activeRun: null, currentAttempt: null, skills: [], recommendations: [],
  summary: { sourceTotal: 0, sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0, onlineAnswered: 0, onlineIndependentCorrect: 0 },
  workload: { remainingItems: 0, estimatedMinutes: null, availableMinutes: null, overloaded: false, message: "未设考期" },
};

it.each([course, "33333333-3333-4333-8333-333333333333"])("keeps the explicit original conversation on course links for %s", currentCourse => {
  const integration = { binding: { courseId: course }, courseGoal: null } as ExamIntegrationOverview;
  state.snapshot = { overview, integration, forecast: null, review: null, busy: false, uncertain: false, error: null };
  const html = renderToStaticMarkup(createElement(ObjectConversationContext.Provider, { value: conversation }, createElement(ExamSprintView, { courseId: currentCourse, embedded: true })));
  const href = currentCourse === course ? `/opening/courses/${course}?conversation=${conversation}` : `/opening/courses/${course}?mode=sprint&amp;conversation=${conversation}`;
  expect(html).toContain(`href="${href}"`);
  expect(html).toContain(currentCourse === course ? "查看课程并调整目标" : "进入已关联课程");
});
