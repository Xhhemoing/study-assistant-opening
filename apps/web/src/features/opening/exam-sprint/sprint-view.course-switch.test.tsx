// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExamIntegrationOverview, ExamSprintOverview } from "@aistudy/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExamSprintView } from "./sprint-view";

const courseA = "11111111-1111-4111-8111-111111111111";
const courseB = "22222222-2222-4222-8222-222222222222";

const client = vi.hoisted(() => ({
  snapshot: {} as { overview: ExamSprintOverview; integration: ExamIntegrationOverview; forecast: null; review: null; busy: boolean; uncertain: boolean; error: string | null },
  listeners: new Set<() => void>(),
  send: vi.fn(), sendIntegration: vi.fn(), load: vi.fn(), loadIntegration: vi.fn(), loadForecast: vi.fn(), dispose: vi.fn(),
  subscribe(listener: () => void) { client.listeners.add(listener); return () => client.listeners.delete(listener); },
  getSnapshot: () => client.snapshot,
}));

const useExamResourcesMock = vi.hoisted(() => vi.fn((_enabled: boolean) => ({
  resources: {
    courses: [{ id: courseA, title: "高数甲" }, { id: courseB, title: "高数乙" }],
    sources: [],
    goals: {},
  },
  loading: false,
  error: null,
  reload: () => undefined,
})));

vi.mock("./client", () => ({ createExamSprintClient: () => client }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("./use-exam-resources", () => ({
  useExamResources: (enabled: boolean) => useExamResourcesMock(enabled),
}));

const lesson = { id: "lesson-1", topicId: "topic-1", title: "复数串讲", summary: "", steps: ["步骤"], workedExample: "例题", pitfalls: [] };
const overview: ExamSprintOverview = {
  pack: {
    id: "pack", version: "1", title: "冲刺", description: "",
    topics: [{ id: "topic-1", title: "复数" }],
    lessons: [{ id: "lesson-1", topicId: "topic-1", title: "复数串讲", summary: "", exposureIdentity: { packVersion: "1", contentFingerprint: "fp", mappingVersion: "mv" } }],
    sourceItems: [], weekPlan: [], limitations: [],
  },
  state: { version: 1, startedAt: "2026-11-14T08:00:00Z", examDate: null, dailyMinutes: 60, runs: [], sourceRecords: [] },
  attempts: [], activeRun: null, currentAttempt: null, lessonContents: [],
  skills: [{ skillId: "skill-1", topicId: "topic-1", lessonId: "lesson-1", title: "复数", status: "weak", independentCorrect: 0, attempted: 1, dueAt: null, reason: "需要再练" }],
  recommendations: [],
  summary: { sourceTotal: 0, sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0, onlineAnswered: 0, onlineIndependentCorrect: 0 },
  workload: { remainingItems: 0, estimatedMinutes: null, availableMinutes: null, overloaded: false, message: "" },
};

let host: HTMLDivElement, root: Root;
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  client.send.mockReset();
  client.sendIntegration.mockReset();
  client.load.mockReset();
  client.loadIntegration.mockReset();
  client.loadForecast.mockReset();
  useExamResourcesMock.mockClear();
  client.listeners.clear();
  client.snapshot = {
    overview: structuredClone(overview),
    integration: { binding: null, links: [], bkt: { calibrated: false, eligible: 0, excluded: 0, bktBrier: null, baselineBrier: null, skills: [], message: "" }, courseGoal: null, sourceMappings: [] },
    forecast: null,
    review: null,
    busy: false,
    uncertain: false,
    error: null,
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("remounts IntegrationPanel when courseId changes on an unbound sprint view", async () => {
  await act(async () => root.render(createElement(ExamSprintView, { courseId: courseA })));
  const firstSelect = host.querySelector<HTMLSelectElement>('section[aria-labelledby="sprint-binding-title"] select');
  expect(firstSelect?.value).toBe(courseA);

  await act(async () => root.render(createElement(ExamSprintView, { courseId: courseB })));
  const secondSelect = host.querySelector<HTMLSelectElement>('section[aria-labelledby="sprint-binding-title"] select');
  expect(secondSelect).not.toBe(firstSelect);
  expect(secondSelect?.value).toBe(courseB);
});

it("resets transient tab, lesson navigation, and lessonError when switching courseId", async () => {
  client.snapshot.integration.binding = { courseId: courseA, milestoneId: null, packSourceId: "pack-src", boundAt: "2026-11-14T08:00:00Z", skills: [], materials: [] };
  client.send.mockImplementation(async () => {
    const next = { ...client.snapshot.overview, lessonContents: [{ exposureId: "exp-1", lesson }] };
    client.snapshot = { ...client.snapshot, overview: next };
    for (const listener of client.listeners) listener();
    return next;
  });

  await act(async () => root.render(createElement(ExamSprintView, { courseId: courseA })));
  await act(async () => host.querySelector<HTMLButtonElement>("#sprint-priority-lesson-1 button")!.click());
  expect(host.querySelector("#sprint-tab-lessons")!.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector("#sprint-lesson-next-step")).not.toBeNull();

  await act(async () => root.render(createElement(ExamSprintView, { courseId: undefined })));
  expect(host.querySelector("#sprint-tab-practice")!.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector("#sprint-lesson-next-step")).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>("#sprint-tab-integration")!.click());
  expect(host.querySelector('section[aria-labelledby="sprint-binding-title"]')).not.toBeNull();
});

it("does not trigger extra loadIntegration or loadForecast calls during a courseId switch transition", async () => {
  client.snapshot.integration.binding = { courseId: courseA, milestoneId: null, packSourceId: "pack-src", boundAt: "2026-11-14T08:00:00Z", skills: [], materials: [] };

  await act(async () => root.render(createElement(ExamSprintView, { courseId: courseA })));
  await act(async () => host.querySelector<HTMLButtonElement>("#sprint-tab-forecast")!.click());
  expect(client.loadForecast).toHaveBeenCalledTimes(1);

  client.loadIntegration.mockClear();
  client.loadForecast.mockClear();
  useExamResourcesMock.mockClear();

  await act(async () => root.render(createElement(ExamSprintView, { courseId: courseB })));
  expect(client.loadForecast).not.toHaveBeenCalled();
  expect(client.loadIntegration).not.toHaveBeenCalled();
  expect(useExamResourcesMock.mock.calls.at(-1)?.[0]).toBe(false);

  await act(async () => root.render(createElement(ExamSprintView, { courseId: courseA })));
  await act(async () => host.querySelector<HTMLButtonElement>("#sprint-tab-integration")!.click());
  expect(client.loadIntegration).toHaveBeenCalledTimes(1);

  client.loadIntegration.mockClear();
  client.loadForecast.mockClear();
  useExamResourcesMock.mockClear();

  await act(async () => root.render(createElement(ExamSprintView, { courseId: undefined })));
  expect(client.loadIntegration).not.toHaveBeenCalled();
  expect(client.loadForecast).not.toHaveBeenCalled();
  expect(host.querySelector("#sprint-tab-practice")!.getAttribute("aria-selected")).toBe("true");
  expect(useExamResourcesMock.mock.calls.at(-1)?.[0]).toBe(false);
});
