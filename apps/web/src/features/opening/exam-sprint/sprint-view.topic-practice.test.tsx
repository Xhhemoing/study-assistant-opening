// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExamSprintOverview } from "@aistudy/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExamSprintView } from "./sprint-view";

const client = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  send: vi.fn(),
  load: vi.fn(),
  dispose: vi.fn(),
  subscribe: () => () => undefined,
  getSnapshot: () => client.snapshot,
}));
vi.mock("./client", () => ({ createExamSprintClient: () => client }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));

const overview: ExamSprintOverview = {
  pack: { id: "math", version: "1", title: "数学冲刺", description: "", sourceItems: [], weekPlan: [], limitations: [],
    topics: [{ id: "topic-1", title: "复数" }, { id: "topic-2", title: "数列与极限" }],
    lessons: [{ id: "limit-lesson", topicId: "topic-2", title: "极限", summary: "", exposureIdentity: null }] },
  state: { version: 1, startedAt: "2026-10-22T08:00:00Z", examDate: null, dailyMinutes: 60, runs: [], sourceRecords: [] },
  lessonContents: [], attempts: [], activeRun: null, currentAttempt: null, skills: [],
  recommendations: [
    { title: "补齐极限", reason: "", lessonId: "limit-lesson", mode: "practice" },
    { title: "极限到期复测", reason: "", lessonId: "limit-lesson", mode: "retest" },
    { title: "下一轮练习安排", reason: "", lessonId: null, mode: "practice" },
  ],
  summary: { sourceTotal: 0, sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0, onlineAnswered: 0, onlineIndependentCorrect: 0 },
  workload: { remainingItems: 0, estimatedMinutes: null, availableMinutes: null, overloaded: false, message: "" },
};

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  client.send.mockReset();
  client.snapshot = { overview: structuredClone(overview), integration: { binding: null }, busy: false, uncertain: false };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("opens the selected chapter directly without a diagnostic", async () => {
  await act(async () => root.render(createElement(ExamSprintView)));
  const selector = host.querySelector<HTMLSelectElement>('select[aria-label="练习章节"]')!;
  const button = Array.from(host.querySelectorAll("button")).find(item => item.textContent === "开始按章练习")!;
  expect(button.disabled).toBe(true);
  await act(async () => { selector.value = "topic-2"; selector.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button.click());
  expect(client.send).toHaveBeenCalledExactlyOnceWith({ action: "start", mode: "practice", topicId: "topic-2" });
});

it("scopes practice recommendations with a lesson and preserves the retest and general practice commands", async () => {
  await act(async () => root.render(createElement(ExamSprintView)));
  for (const index of [0, 1, 2]) {
    const button = host.querySelector<HTMLButtonElement>(`#sprint-recommendation-${index} button:last-child`)!;
    await act(async () => button.click());
  }
  expect(client.send.mock.calls.map(([command]) => command)).toEqual([
    { action: "start", mode: "practice", topicId: "topic-2" },
    { action: "start", mode: "retest" },
    { action: "start", mode: "practice" },
  ]);
});

it.each(["lesson", "topic"] as const)("does not start a global practice when a recommendation's %s is missing", async missing => {
  const current = client.snapshot.overview as ExamSprintOverview;
  if (missing === "lesson") current.pack.lessons = [];
  else current.pack.topics = [];
  await act(async () => root.render(createElement(ExamSprintView)));
  const button = host.querySelector<HTMLButtonElement>('#sprint-recommendation-0 button:last-child')!;
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(client.send).not.toHaveBeenCalled();
});
