// @vitest-environment jsdom
import type { ExamIntegrationOverview, ExamSprintOverview } from "@aistudy/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CourseSprintPack, coursePackStatus } from "./course-sprint-pack";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const startedAt = "2026-10-17T00:00:00Z";
const scopedPath = `/api/opening/courses/${id}/exam-sprint`;
const overviewPath = "/api/opening/exam-sprint";
const integrationPath = `${overviewPath}/integration`;
const emptyOverview: ExamSprintOverview = {
  pack: { id: "math-i", version: "1", title: "考前冲刺", description: "", topics: [], lessons: [], sourceItems: [], weekPlan: [], limitations: [] },
  state: { version: 1, startedAt, examDate: null, dailyMinutes: 60, runs: [], sourceRecords: [] },
  lessonContents: [], attempts: [], activeRun: null, currentAttempt: null, skills: [], recommendations: [],
  summary: { sourceTotal: 0, sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0, onlineAnswered: 0, onlineIndependentCorrect: 0 },
  workload: { remainingItems: 0, estimatedMinutes: null, availableMinutes: null, overloaded: false, message: "" },
};
const activeRun = { id: "existing-run", mode: "diagnostic" as const, questionIds: ["question-1"], startedAt, deadlineAt: null, completedAt: null };
const currentAttempt: NonNullable<ExamSprintOverview["currentAttempt"]> = {
  id: "existing-attempt", runId: activeRun.id, questionId: "question-1", presentedAt: startedAt,
  answeredAt: null, answer: null, correct: null, confidence: null, durationSeconds: null, help: [], errorCause: null,
  question: { id: "question-1", topicId: "limits", skillId: "limit", familyId: "factor", lessonId: "lesson-1",
    difficulty: "foundation", prompt: "已保存的摸底题", options: [{ id: "A", label: "选择 A" }], estimatedMinutes: 2 },
  feedback: null, hint: null, independent: false,
};
const activeOverview: ExamSprintOverview = {
  ...emptyOverview, state: { ...emptyOverview.state, runs: [activeRun] }, activeRun, currentAttempt, attempts: [currentAttempt],
};

function integration(courseId: string | null): ExamIntegrationOverview {
  return {
    binding: courseId ? { courseId, packSourceId: "source-1", boundAt: startedAt, milestoneId: null, skills: [], materials: [] } : null,
    links: [], sourceMappings: [], courseGoal: null,
    bkt: { calibrated: false, eligible: 0, excluded: 0, bktBrier: null, baselineBrier: null, skills: [], message: "" },
  };
}

describe("course sprint sample pack gate", () => {
  it("treats only a course-scoped binding as bound", () => {
    expect(coursePackStatus(null)).toBe("unbound");
    expect(coursePackStatus({ integration: { binding: null } })).toBe("unbound");
    expect(coursePackStatus({ integration: { binding: { courseId: id } }, overview: {} })).toBe("bound");
  });
  it("shows a course-materials empty state and keeps the sample pack collapsed for unbound courses", () => {
    const html = renderToStaticMarkup(createElement(CourseSprintPack, { courseId: id, initialStatus: "unbound" }));
    expect(html).toContain("这门课还没有冲刺题包");
    expect(html).toContain(`/opening/courses/${id}?tab=materials`);
    expect(html).toContain("导入示例题包");
    expect(html).not.toContain("对应真实资料");
    expect(html).not.toContain("<details open");
  });
  it("does not render pack content while checking the binding", () => {
    const html = renderToStaticMarkup(createElement(CourseSprintPack, { courseId: id }));
    expect(html).not.toContain("导入示例题包");
    expect(html).not.toContain("题包训练");
  });
});

describe("course sprint training entry", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let host: HTMLDivElement;
  let root: Root;
  let binding: string | null;
  let overview: ExamSprintOverview;
  let failScopedRead: boolean;
  let scopedBinding: string | null;
  const writes: Array<{ path: string; command: unknown }> = [];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    binding = id;
    scopedBinding = id;
    overview = emptyOverview;
    failScopedRead = false;
    writes.length = 0;
    fetchMock.mockReset().mockImplementation(async (path, init) => {
      if (init?.method === "POST") {
        writes.push({ path: String(path), command: JSON.parse(String(init.body)) });
        if (path === integrationPath) {
          binding = id;
          return Response.json(integration(binding));
        }
        overview = activeOverview;
        return Response.json(overview);
      }
      if (path === scopedPath) return failScopedRead ? Response.json(null, { status: 503 })
        : Response.json(scopedBinding === id ? { overview, integration: integration(scopedBinding) } : null);
      if (path === overviewPath) return Response.json(overview);
      if (path === integrationPath) return Response.json(integration(binding));
      if (path === "/api/courses") return Response.json({ courses: [{ id, title: "高等数学" }] });
      if (path === "/api/opening/sources") return Response.json([]);
      if (path === "/api/opening/adaptive-planning") return Response.json({ prefs: { autonomy: "copilot", coachBudgetMinutes: 60, courseGoals: {} } });
      return Response.json(null, { status: 404 });
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const mount = () => act(async () => root.render(createElement(CourseSprintPack, { courseId: id },
    createElement("h2", { id: "plan" }, "今天的任务"))));
  const action = (label: string) => [...host.querySelectorAll<HTMLElement>("button, summary")].find(item => item.textContent === label);
  const visible = (item: HTMLElement | undefined) => !!item && !item.closest("[hidden], details:not([open])");
  async function click(label: string, expectedWrites?: number) {
    const target = action(label);
    expect(target).toBeDefined();
    await act(async () => {
      target!.click();
      if (expectedWrites !== undefined) {
        await vi.waitFor(() => expect(writes).toHaveLength(expectedWrites));
        await new Promise(resolve => setTimeout(resolve, 0));
      } else if (target!.tagName === "SUMMARY") {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    });
  }

  it("exposes the real diagnostic action ahead of the plan", async () => {
    await mount();
    const start = action("开始摸底诊断");
    expect(visible(start)).toBe(true);
    expect(start!.compareDocumentPosition(host.querySelector("#plan")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("当前训练");
    expect(writes).toEqual([]);
    await click("开始摸底诊断", 1);
    expect(writes).toEqual([{ path: overviewPath, command: { action: "start", mode: "diagnostic", clientKey: expect.any(String) } }]);
    expect(visible(action("提交本题"))).toBe(true);
  });

  it("reopens the original active attempt with no new start", async () => {
    overview = activeOverview;
    await mount();
    const answer = host.querySelector<HTMLInputElement>('input[name="answer-existing-attempt"]');
    expect(visible(answer ?? undefined)).toBe(true);
    expect(host.textContent).toContain("已保存的摸底题");
    expect(writes).toEqual([]);
  });

  it("opens training after an explicit association in the same view", async () => {
    binding = scopedBinding = null;
    await mount();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([scopedPath]);
    const plan = host.querySelector("#plan");
    expect(plan).not.toBeNull();
    await click("导入示例题包");
    expect(action("开始摸底诊断")).toBeUndefined();
    await click("导入预置考点和串讲到课程", 1);
    expect(host.querySelector("#plan")).toBe(plan);
    const trainingReads = fetchMock.mock.calls.filter(([path, init]) =>
      init?.method === "GET" && (path === overviewPath || path === integrationPath));
    expect(trainingReads.map(([path]) => path)).toEqual([overviewPath, integrationPath]);
    expect(writes).toEqual([{ path: integrationPath, command: expect.objectContaining({ courseId: id }) }]);
    expect(visible(action("开始摸底诊断"))).toBe(true);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("当前训练");
  });

  it("retries a failed course lookup without unlocking another course's training", async () => {
    failScopedRead = true;
    binding = otherId;
    await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("暂时无法读取冲刺题包");
    expect(action("开始摸底诊断")).toBeUndefined();
    failScopedRead = false;
    await click("重新读取");
    expect(host.querySelector(`a[href="/opening/courses/${otherId}?mode=sprint"]`)).toBeTruthy();
    expect(action("开始摸底诊断")).toBeUndefined();
    expect(writes).toEqual([]);
  });
});
