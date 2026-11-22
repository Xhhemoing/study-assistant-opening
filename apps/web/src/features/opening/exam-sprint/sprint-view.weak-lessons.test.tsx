// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExamLesson, ExamSprintOverview } from "@aistudy/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExamSprintView } from "./sprint-view";
import { sprintSkillSupport } from "./skill-priorities";
import { SkillsAndLessons } from "./learning-plan";

const client = vi.hoisted(() => ({
  snapshot: {} as { overview: ExamSprintOverview; integration: { binding: null }; busy: boolean; uncertain: boolean; error?: string | null },
  listeners: new Set<() => void>(),
  send: vi.fn(), recover: vi.fn(), load: vi.fn(), loadIntegration: vi.fn(), loadForecast: vi.fn(), dispose: vi.fn(),
  subscribe(listener: () => void) { client.listeners.add(listener); return () => client.listeners.delete(listener); },
  getSnapshot: () => client.snapshot,
}));
vi.mock("./client", () => ({ createExamSprintClient: () => client }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("./use-exam-resources", () => ({ useExamResources: () => ({ resources: { courses: [], sources: [], goals: {} }, loading: false, error: null, reload: () => undefined }) }));

const lessons: ExamLesson[] = ["已初步可用", "薄弱一", "薄弱二", "薄弱三", "薄弱四"].map((title, index) => ({
  id: `lesson-${index}`, topicId: "topic", title, summary: `${title}的方法摘要`,
  steps: [`${title}的关键步骤`], workedExample: `${title}的完整例题`, pitfalls: [`${title}的易错点`],
}));
function fixture(): ExamSprintOverview {
  return {
    pack: { id: "pack", version: "1", title: "冲刺", description: "", topics: [{ id: "topic", title: "本章" }],
      lessons: lessons.map(({ id, topicId, title, summary }) => ({ id, topicId, title, summary,
        exposureIdentity: { packVersion: "1", contentFingerprint: `content-${id}`, mappingVersion: "mapping-1" } })),
      sourceItems: [], weekPlan: [], limitations: [] },
    state: { version: 1, startedAt: "2026-11-14T08:00:00Z", examDate: null, dailyMinutes: 60, runs: [], sourceRecords: [] },
    attempts: [], activeRun: null, currentAttempt: null, lessonContents: [],
    skills: lessons.map<ExamSprintOverview["skills"][number]>((lesson, index) => ({ skillId: `skill-${index}`, topicId: lesson.topicId, lessonId: lesson.id,
      title: lesson.title, status: index === 0 ? "usable" : "weak", independentCorrect: index === 0 ? 1 : 0,
      attempted: 1, dueAt: null, reason: index === 0 ? "有一次独立正确证据" : "最近答错或求助" })),
    recommendations: lessons.map<ExamSprintOverview["recommendations"][number]>(lesson => ({ title: `继续：${lesson.title}`, lessonId: lesson.id, reason: "根据本题包记录", mode: "practice" })),
    summary: { sourceTotal: 0, sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0, onlineAnswered: 0, onlineIndependentCorrect: 0 },
    workload: { remainingItems: 0, estimatedMinutes: null, availableMinutes: null, overloaded: false, message: "" },
  };
}

function submittedAttempt(confidence: number, answeredAt = "2026-11-14T08:01:00Z", runId = "practice"): ExamSprintOverview["attempts"][number] {
  return { id: `attempt-${answeredAt}`, runId, questionId: "question", presentedAt: "2026-11-14T08:00:00Z",
    answeredAt, answer: "A", correct: true, confidence, durationSeconds: 60,
    help: [], errorCause: null, independent: true, hint: null, feedback: null,
    question: { id: "question", topicId: "topic", skillId: "skill-0", lessonId: "lesson-0", familyId: "family",
      difficulty: "foundation", prompt: "已答题目", options: [], estimatedMinutes: 1 } };
}

let host: HTMLDivElement, root: Root;
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  client.send.mockReset(); client.listeners.clear();
  client.snapshot = { overview: fixture(), integration: { binding: null }, busy: false, uncertain: false };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("shows every weak lesson in the main area before usable suggestions, including a fourth weak lesson", async () => {
  await act(async () => root.render(createElement(ExamSprintView)));
  const priority = host.querySelector<HTMLElement>('section[aria-label="优先讲解"]');
  expect(priority).not.toBeNull();
  expect(priority!.hidden).toBe(false);
  expect(priority!.textContent).not.toContain("已初步可用");
  for (const lesson of lessons.slice(1)) expect(priority!.textContent).toContain(lesson.title);
  expect(priority!.querySelectorAll("button")).toHaveLength(4);
  const recommendations = Array.from(host.querySelectorAll('[id^="sprint-recommendation-"]'));
  expect(recommendations[0]?.textContent).toContain("薄弱一");
  expect(recommendations[0]?.textContent).not.toContain("已初步可用");
  expect(client.send).not.toHaveBeenCalled();
});

it("opens the existing lesson from a priority entry without changing the current run or saved answer", async () => {
  const overview = client.snapshot.overview;
  const run = { id: "run", mode: "practice" as const, questionIds: ["question"], startedAt: overview.state.startedAt, deadlineAt: null, completedAt: null };
  const attempt = { id: "attempt", runId: run.id, questionId: "question", presentedAt: run.startedAt,
    answeredAt: "2026-11-14T08:01:00Z", answer: "A", correct: false, confidence: 3, durationSeconds: 60,
    help: [], errorCause: null, independent: true, hint: null, feedback: { answer: "B", explanation: "本题解析" },
    question: { id: "question", topicId: "topic", skillId: "skill-1", lessonId: "lesson-1", familyId: "family",
      difficulty: "foundation" as const, prompt: "原题题干", options: [{ id: "A", label: "原错误答案" }, { id: "B", label: "正确答案" }], estimatedMinutes: 1 } };
  overview.activeRun = run; overview.currentAttempt = attempt; overview.state.runs = [run]; overview.attempts = [attempt];
  const original = structuredClone({ run, attempt });
  client.send.mockImplementation(async () => {
    const next = { ...overview, lessonContents: [{ exposureId: "confirmed-exposure", lesson: lessons[1]! }] };
    client.snapshot = { ...client.snapshot, overview: next };
    for (const listener of client.listeners) listener();
    return next;
  });
  await act(async () => root.render(createElement(ExamSprintView)));
  const button = host.querySelector<HTMLButtonElement>('section[aria-label="优先讲解"] button');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  expect(client.send).toHaveBeenCalledExactlyOnceWith({ action: "open_lesson", lessonId: "lesson-1", expectedRunId: "run",
    expectedAttemptId: "attempt", packVersion: "1", contentFingerprint: "content-lesson-1", mappingVersion: "mapping-1" });
  expect(host.textContent).toContain(lessons[1]!.steps[0]);
  expect(host.textContent).toContain(lessons[1]!.workedExample);
  expect(host.textContent).toContain(lessons[1]!.pitfalls[0]);
  expect(client.snapshot.overview.activeRun).toEqual(original.run);
  expect(client.snapshot.overview.currentAttempt).toEqual(original.attempt);
  const returnButton = Array.from(host.querySelectorAll("button")).find(item => item.textContent === "返回优先讲解");
  expect(returnButton).toBeDefined();
  await act(async () => returnButton!.click());
  expect(host.querySelector('[aria-label="优先讲解"]')).not.toBeNull();
  expect(client.send).toHaveBeenCalledTimes(1);
  expect(client.snapshot.overview.attempts[0]!.answer).toBe("A");
});

it.each(["busy", "uncertain"] as const)("locks priority lesson writes while %s", async flag => {
  client.snapshot = { ...client.snapshot, [flag]: true };
  await act(async () => root.render(createElement(ExamSprintView)));
  const button = host.querySelector<HTMLButtonElement>('section[aria-label="优先讲解"] button');
  expect(button).not.toBeNull();
  expect(button!.disabled).toBe(true);
  await act(async () => button!.click());
  expect(client.send).not.toHaveBeenCalled();
});

it("allows another lesson selection after recovery definitively rejects the previous one", async () => {
  function settle(uncertain: boolean) {
    client.snapshot = { ...client.snapshot, uncertain, error: uncertain ? "结果待确认" : "串讲已更新" };
    for (const listener of client.listeners) listener();
    return null;
  }
  client.send.mockImplementationOnce(async () => settle(true));
  client.recover.mockImplementationOnce(async () => settle(false));
  await act(async () => root.render(createElement(ExamSprintView)));
  const lesson = (id: number) => host.querySelector<HTMLButtonElement>(`#sprint-priority-lesson-${id} button`)!;
  await act(async () => lesson(1).click());
  expect(lesson(2).disabled).toBe(true);
  await act(async () => findButton(host, "核对进度并恢复上一操作").click());
  await act(async () => lesson(2).click());
  expect(client.send.mock.calls.map(([command]) => command.lessonId)).toEqual(["lesson-1", "lesson-2"]);
});

it("offers low-confidence and untested lessons in the main area and directly beside skill status", async () => {
  const overview = client.snapshot.overview;
  overview.skills[4] = { ...overview.skills[4]!, status: "untested", attempted: 0, reason: "还没有有效作答" };
  overview.attempts = [submittedAttempt(2)];
  client.send.mockImplementation(async () => {
    const next = { ...overview, lessonContents: [{ exposureId: "low-confidence-lesson", lesson: lessons[0]! }] };
    client.snapshot = { ...client.snapshot, overview: next };
    for (const listener of client.listeners) listener();
    return next;
  });
  await act(async () => root.render(createElement(ExamSprintView)));
  const priority = host.querySelector<HTMLElement>('section[aria-label="优先讲解"]')!;
  expect(priority.textContent).toContain("已初步可用");
  expect(priority.textContent).toContain("不太确定");
  expect(priority.textContent).toContain("薄弱四");
  expect(priority.textContent).toContain("未测");
  const lowConfidenceButton = priority.querySelector<HTMLButtonElement>('#sprint-priority-lesson-0 button')!;
  await act(async () => lowConfidenceButton.click());
  expect(client.send).toHaveBeenCalledExactlyOnceWith({ action: "open_lesson", lessonId: "lesson-0", expectedRunId: null,
    expectedAttemptId: null, packVersion: "1", contentFingerprint: "content-lesson-0", mappingVersion: "mapping-1" });
  expect(host.querySelector<HTMLDetailsElement>('#lesson-lesson-0')!.open).toBe(true);
  expect(host.querySelector('#lesson-lesson-0')!.textContent).toContain(lessons[0]!.workedExample);
  const skillDetails = host.querySelector('#sprint-skill-skill-0')!.closest('details')!;
  expect(skillDetails.open).toBe(false);
  const directButton = skillDetails.parentElement!.querySelector<HTMLButtonElement>(':scope > div button');
  expect(directButton).not.toBeNull();
  expect(directButton!.disabled).toBe(false);
});

it("uses the latest submitted skill confidence and excludes an unfinished mock", () => {
  const overview = fixture(), skill = overview.skills[0]!;
  overview.attempts = [submittedAttempt(1)];
  expect(sprintSkillSupport(overview, skill)).toMatchObject({ priority: 1, label: "不太确定" });
  overview.attempts.unshift(submittedAttempt(4, "2026-11-14T08:02:00Z"));
  expect(sprintSkillSupport(overview, skill)).toBeNull();
  const mock = { id: "mock", mode: "mock-a" as const, questionIds: ["question"], startedAt: "2026-11-14T08:03:00Z", deadlineAt: null, completedAt: null };
  overview.state.runs.push(mock); overview.activeRun = mock;
  overview.attempts.push(submittedAttempt(1, "2026-11-14T08:04:00Z", mock.id));
  expect(sprintSkillSupport(overview, skill)).toBeNull();
  overview.state.runs[0]!.completedAt = "2026-11-14T08:05:00Z"; overview.activeRun = null;
  expect(sprintSkillSupport(overview, skill)).toMatchObject({ priority: 1, label: "不太确定" });
});

const findButton = (container: ParentNode, label: string) => Array.from(container.querySelectorAll("button")).find(item => item.textContent === label)!;

it("starts a skill's chapter practice while keeping its optional due retest global", async () => {
  const overview = fixture(), send = vi.fn();
  overview.pack.topics.push({ id: "other-topic", title: "另一章" });
  overview.skills[1] = { ...overview.skills[1]!, topicId: "other-topic", dueAt: "2000-01-01T00:00:00Z" };
  await act(async () => root.render(createElement(SkillsAndLessons, { overview, disabled: false, send })));
  const row = host.querySelector('#sprint-skill-skill-1')!.closest('details')!.parentElement!;
  const practice = findButton(row, "练本章新题");
  expect(practice).toBeDefined();
  await act(async () => practice.click());
  expect(send).toHaveBeenLastCalledWith({ action: "start", mode: "practice", topicId: "other-topic" });
  const retest = findButton(row, "到期复测（全局）");
  expect(retest).toBeDefined();
  await act(async () => retest.click());
  expect(send.mock.calls.map(([command]) => command)).toEqual([
    { action: "start", mode: "practice", topicId: "other-topic" }, { action: "start", mode: "retest" },
  ]);
});

it("does not fall back to global practice when a skill chapter is unavailable", async () => {
  const overview = fixture(), send = vi.fn();
  overview.skills[1] = { ...overview.skills[1]!, topicId: "missing-topic", lessonId: "missing-lesson" };
  await act(async () => root.render(createElement(SkillsAndLessons, { overview, disabled: false, send, onOpenLesson: () => undefined })));
  const row = host.querySelector('#sprint-skill-skill-1')!.closest('details')!.parentElement!;
  const practice = findButton(row, "练本章新题");
  expect(practice).toBeDefined();
  expect(practice.disabled).toBe(true);
  await act(async () => practice.click());
  expect(send).not.toHaveBeenCalled();
  expect(row.textContent).toContain("章节暂不可用");
});

async function openPriorityLesson() {
  client.send.mockImplementation(async () => {
    const next = { ...client.snapshot.overview, lessonContents: [{ exposureId: "chapter-practice-lesson", lesson: lessons[1]! }] };
    client.snapshot = { ...client.snapshot, overview: next };
    for (const listener of client.listeners) listener();
    return next;
  });
  await act(async () => root.render(createElement(ExamSprintView)));
  await act(async () => host.querySelector<HTMLButtonElement>('#sprint-priority-lesson-1 button')!.click());
  client.send.mockClear();
}

it("continues an opened lesson with its chapter practice and returns to the current-training tab", async () => {
  await openPriorityLesson();
  expect(host.querySelector<HTMLDetailsElement>('#lesson-lesson-1')!.open).toBe(true);
  const practice = findButton(host.querySelector('#sprint-lesson-next-step')!, "练本章新题");
  expect(practice).toBeDefined();
  await act(async () => practice.click());
  expect(client.send).toHaveBeenCalledExactlyOnceWith({ action: "start", mode: "practice", topicId: "topic" });
  expect(host.querySelector('#sprint-tab-practice')!.getAttribute('aria-selected')).toBe("true");
});

it.each(["busy", "uncertain", "active"] as const)("locks opened-lesson practice while %s", async flag => {
  if (flag === "active") {
    const overview = client.snapshot.overview;
    const run = { id: "existing", mode: "practice" as const, questionIds: ["question"], startedAt: overview.state.startedAt, deadlineAt: null, completedAt: null };
    overview.state.runs.push(run); overview.activeRun = run;
  }
  await openPriorityLesson();
  if (flag !== "active") await act(async () => {
    client.snapshot = { ...client.snapshot, [flag]: true };
    for (const listener of client.listeners) listener();
  });
  const banner = host.querySelector('#sprint-lesson-next-step')!;
  const practice = findButton(banner, "练本章新题");
  expect(practice).toBeDefined();
  expect(practice.disabled).toBe(true);
  await act(async () => practice.click());
  expect(client.send).not.toHaveBeenCalled();
  if (flag === "active") expect(banner.textContent).toContain("先结束本轮");
});

it.each(["busy", "uncertain", "active"] as const)("rejects lesson practice when the latest client state becomes %s before the UI rerenders", async flag => {
  await openPriorityLesson();
  const practice = findButton(host.querySelector('#sprint-lesson-next-step')!, "练本章新题");
  expect(practice.disabled).toBe(false);
  if (flag === "active") {
    const run = { id: "new-active", mode: "practice" as const, questionIds: ["question"], startedAt: "2026-11-14T09:00:00Z", deadlineAt: null, completedAt: null };
    client.snapshot = { ...client.snapshot, overview: { ...client.snapshot.overview, activeRun: run } };
  } else client.snapshot = { ...client.snapshot, [flag]: true };
  await act(async () => practice.click());
  expect(client.send).not.toHaveBeenCalled();
});

it("keeps lesson reading available without falling back to global practice when its topic is missing", async () => {
  client.snapshot.overview.pack.topics = [];
  await openPriorityLesson();
  const banner = host.querySelector('#sprint-lesson-next-step')!;
  const practice = findButton(banner, "练本章新题");
  expect(practice).toBeDefined();
  expect(practice.disabled).toBe(true);
  await act(async () => practice.click());
  expect(client.send).not.toHaveBeenCalled();
  expect(host.querySelector('#lesson-lesson-1')!.textContent).toContain(lessons[1]!.workedExample);
});

it("offers same-page knowledge and source routes even before starting practice", async () => {
  await act(async () => root.render(createElement(ExamSprintView)));
  const start = host.querySelector('section[aria-labelledby="sprint-start-title"]')!;
  const knowledge = findButton(start, "先梳理知识点"), sources = findButton(start, "查看原题");
  expect(knowledge).toBeDefined();
  expect(sources).toBeDefined();
  await act(async () => knowledge.click());
  expect(host.querySelector('#sprint-tab-lessons')!.getAttribute('aria-selected')).toBe("true");
  expect(client.send).not.toHaveBeenCalled();
  await act(async () => sources.click());
  expect(host.querySelector('#sprint-tab-sources')!.getAttribute('aria-selected')).toBe("true");
  expect(client.send).not.toHaveBeenCalled();
});

it("keeps the lesson open on the lessons tab when starting practice fails or is still in flight", async () => {
  await openPriorityLesson();
  let resolveStart!: (value: ExamSprintOverview | null) => void;
  client.send.mockImplementationOnce(() => new Promise<ExamSprintOverview | null>(resolve => { resolveStart = resolve; }));
  const practice = findButton(host.querySelector('#sprint-lesson-next-step')!, "练本章新题");
  await act(async () => practice.click());
  expect(host.querySelector('#sprint-tab-lessons')!.getAttribute('aria-selected')).toBe("true");
  expect(host.querySelector<HTMLDetailsElement>('#lesson-lesson-1')!.open).toBe(true);

  await act(async () => {
    client.snapshot = { ...client.snapshot, error: "本章没有新的针对题" };
    for (const listener of client.listeners) listener();
    resolveStart(null);
  });
  expect(host.querySelector('#sprint-tab-lessons')!.getAttribute('aria-selected')).toBe("true");
  expect(host.querySelector<HTMLDetailsElement>('#lesson-lesson-1')!.open).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("本章没有新的针对题");

  client.send.mockResolvedValueOnce(client.snapshot.overview);
  await act(async () => practice.click());
  expect(host.querySelector('#sprint-tab-practice')!.getAttribute('aria-selected')).toBe("true");
});
