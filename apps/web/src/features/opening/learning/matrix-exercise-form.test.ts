// @vitest-environment jsdom

vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => true }));
import { act, createElement, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { LearningAttempt, MatrixExerciseInput } from "@aistudy/contracts";
import { createMatrixExerciseSpec } from "@aistudy/domain";
import CourseStudyPage from "../../../app/(opening)/opening/courses/[id]/study/page";
import { MatrixExerciseForm } from "./matrix-exercise-form";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";
import { emptyPracticeDraft, initializePracticeDraft, practiceScope, switchPracticeDraft, type PracticeDraftCollection } from "./practice-draft";

const client = vi.hoisted(() => ({
  createSession: vi.fn(), createAttempt: vi.fn(), getAttempt: vi.fn(), listObservations: vi.fn(),
  submitAttempt: vi.fn(), getObservationHistory: vi.fn(), getSummary: vi.fn().mockResolvedValue([]),
}));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => client }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ useRouter: () => null, usePathname: () => window.location.pathname }));
vi.mock("@aistudy/ai", () => ({ isTeachingCompilerEnabled: () => false }));
vi.mock("../courses/server/course-span-resume", () => ({ loadCourseSpanResume: vi.fn() }));
vi.mock("../courses/server/course-study-context", () => ({
  loadCourseStudyContext: async (_request: Request, _courseId: string, sourceId?: string) =>
    ({ teachingEnabled: false, sourceIds: [sourceId], timeZone: "Asia/Shanghai", boundPracticeSourceAvailable: Boolean(sourceId) }),
}));
vi.mock("../courses/course-detail", () => ({
  useCourseBundle: (courseId: string) => useMemo(() => ({ course: { id: courseId, title: "线性代数" }, loading: false }), [courseId]),
}));

function boundScope(courseId: string, exercise: MatrixExerciseInput) {
  return practiceScope(courseId, "matrix", undefined, undefined, undefined, exercise);
}

it("offers real start controls, labels the built-in source honestly and blocks an empty material selection", () => {
  const html = renderToStaticMarkup(createElement(MatrixExerciseForm, {
    courseId: "course", sources: [], onRecorded() {}, onBack() {},
  }));
  expect(html).toContain("内置矩阵练习");
  expect(html).toContain("正在恢复矩阵练习");
  expect(html).toContain('<fieldset disabled=""');
  expect(html).toContain("这是内置矩阵练习");
  expect(html).toContain("选择可用课程材料");
  expect(html).toContain("请先添加并完成解析一份材料");
  expect(html).toMatch(/<button disabled=""[^>]*>开始矩阵练习<\/button>/);
  expect(html).toContain("矩阵标量乘法");
});
it("distinguishes an automatic verdict from a learner's documented reference check", () => {
  const html = renderToStaticMarkup(createElement(LearningEvidenceEligibilityDetails, { eligibility: {
    independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown",
    reasonCodes: ["deterministic_correct"], policyVersion: "opening-evidence-v1",
  } }));
  expect(html).toContain("内置题精确核算");
  expect(html).toContain("只覆盖这道结构化题目");
  expect(html).not.toContain("不代表系统客观判分");
});
it("seeds the exact exercise and variation of a new matrix entry while draft reads are pending", () => {
  const html = renderToStaticMarkup(createElement(MatrixExerciseForm, { courseId: "new-course", sources: [], initialKey: "addition", initialVariant: 2, onRecorded() {}, onBack() {} }));
  expect(html).toContain('<option value="addition" selected="">');
  expect(html).toContain("本次题组：3");
  expect(html).toContain('<fieldset disabled=""');
});

it("reopens the switched matrix draft from the updated URL and the original draft from its summary link", async () => {
  const courseId = crypto.randomUUID(), sourceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID(), observationId = crypto.randomUUID();
  const linked = { sourceId, exerciseKey: "addition", variant: 2 } as const;
  const next = { ...linked, variant: 3 };
  client.createSession.mockResolvedValue({ id: sessionId });
  client.createAttempt.mockImplementation(async ({ matrixExercise }: { matrixExercise: MatrixExerciseInput }): Promise<LearningAttempt> => ({
    id: crypto.randomUUID(), workspaceId: courseId, courseId, sessionId,
    skillLabel: "矩阵加法", requirementKey: null, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 },
    problemId: null, itemVersionId: null, observationId: null, submittedAt: null,
    startedAt: "2026-11-20T00:00:00Z", historyRevision: 0,
    matrixExercise: createMatrixExerciseSpec(matrixExercise.exerciseKey, matrixExercise.variant),
  }));
  client.getAttempt.mockImplementation(async (attemptId: string) => ({ attemptId, sessionId, deliveredAssistance: "none" }));
  client.listObservations.mockResolvedValue([]);
  const observation = { id: observationId, courseId, sessionId, attemptId: "", answer: "[[1]]" };
  client.submitAttempt.mockImplementation(async (attemptId: string) => ({ ...observation, attemptId }));
  client.getObservationHistory.mockImplementation(async () => ({
    rootObservationId: observationId, headObservationId: observationId,
    revisions: [await client.submitAttempt.mock.results[0]!.value],
  }));

  const host = document.createElement("div");
  const root = createRoot(host);
  const originalUrl = window.location.href;
  const entryUrl = `/opening/courses/${courseId}/study?mode=matrix&exercise=addition&variant=2&sourceId=${sourceId}#practice`;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const open = () => act(async () => root.render(await CourseStudyPage({
    params: Promise.resolve({ id: courseId }),
    searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(window.location.search))),
  })));
  const submit = () => act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const typeAnswer = (answer: string) => act(async () => {
    const input = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, answer);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const stored = (exercise: MatrixExerciseInput) => sessionStorage.getItem(`opening-practice:v2:${boundScope(courseId, exercise)}`);
  try {
    window.history.replaceState(null, "", entryUrl);
    await open();
    await submit();
    await typeAnswer("[[1]]");
    await submit();
    expect(host.textContent).toContain("原答案：[[1]]");
    const original = stored(linked);
    expect(original).toBeTruthy();

    const switchQuestion = [...host.querySelectorAll("button")].find(button => button.textContent === "换一道题");
    expect(switchQuestion).toBeDefined();
    await act(async () => switchQuestion!.click());
    expect(host.textContent).toContain("本次题组：4");
    await submit();
    await typeAnswer("[[2]]");
    expect(client.createAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ matrixExercise: next }));

    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(entryUrl.replace("variant=2", "variant=3"));
    await act(async () => root.render(null));
    await open();
    expect(host.textContent).toContain("本次题组：4");
    expect(host.querySelector("textarea")?.value).toBe("[[2]]");
    expect(stored(next)).toBeTruthy();

    await act(async () => root.render(null));
    window.history.replaceState(null, "", entryUrl);
    await open();
    expect(host.textContent).toContain("本次题组：3");
    expect(host.querySelector("textarea")?.value).toBe("[[1]]");
    expect(stored(linked)).toBe(original);
  } finally {
    await act(async () => root.unmount());
    window.history.replaceState(null, "", originalUrl);
    vi.unstubAllGlobals();
    sessionStorage.clear();
  }
});

function studyEntry(courseId: string) {
  const host = document.createElement("div");
  let root: ReturnType<typeof createRoot> | undefined;
  const originalUrl = window.location.href;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

  async function unmount() {
    await act(async () => root?.unmount());
    root = undefined;
  }
  return {
    host,
    async open() {
      await unmount();
      const page = await CourseStudyPage({
        params: Promise.resolve({ id: courseId }),
        searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(window.location.search))),
      });
      root = createRoot(host);
      await act(async () => root!.render(page));
    },
    click: (text: string) => act(async () => {
      const button = [...host.querySelectorAll("button")].find(item => item.textContent === text);
      expect(button).toBeDefined();
      button!.click();
    }),
    answer: () => host.querySelector("fieldset textarea")?.value,
    async cleanUp() {
      await unmount();
      window.history.replaceState(null, "", originalUrl);
      vi.unstubAllGlobals();
      sessionStorage.clear();
    },
  };
}

const storageKey = (scope: string) => `opening-practice:v2:${scope}`;
function storedCollection(scope: string): PracticeDraftCollection | null {
  return JSON.parse(sessionStorage.getItem(storageKey(scope)) ?? "null");
}

it.each([
  { phase: "before reopening", editBeforeReopen: true },
  { phase: "after reopening", editBeforeReopen: false },
])("moves the bound draft before switching the URL and keeps edits made $phase", async ({ editBeforeReopen }) => {
  const courseId = crypto.randomUUID(), sourceId = crypto.randomUUID();
  const linked = { sourceId, exerciseKey: "addition", variant: 2 } as const;
  const target = { ...linked, variant: 3 };
  const scope = boundScope(courseId, linked), targetScope = boundScope(courseId, target);
  const fields = { sourceId, matrixKey: linked.exerciseKey, matrixVariant: linked.variant };
  const original = emptyPracticeDraft(scope, { ...fields, answer: "[[1]]" });
  const archived = emptyPracticeDraft(scope, { ...fields, matrixVariant: 3, answer: "[[2]]" });
  archived.start = {
    sessionId: null, clientKey: `matrix-start:${crypto.randomUUID()}`, createInput: null,
    sessionInput: { courseId, sourceIds: [sourceId], skillLabel: "矩阵加法" },
  };
  const existingTarget = emptyPracticeDraft(targetScope, { ...fields, matrixVariant: 3, answer: "[[99]]" });
  sessionStorage.setItem(storageKey(targetScope), JSON.stringify({
    version: 2, scope: targetScope, activeId: existingTarget.id, drafts: [existingTarget],
  }));
  initializePracticeDraft(original);
  // Older bound collections could have a different variant active under the original URL.
  switchPracticeDraft(scope, original.id, archived, sessionStorage);

  const view = studyEntry(courseId);
  const entryUrl = `/opening/courses/${courseId}/study?mode=matrix&exercise=addition&variant=2&sourceId=${sourceId}&conversation=keep#practice`;
  const currentUrl = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
  try {
    window.history.replaceState(null, "", entryUrl);
    await view.open();
    expect(view.host.textContent).toContain("本次题组：3");
    expect(storedCollection(scope)?.activeId).toBe(original.id);

    for (const failingScope of [targetScope, scope]) {
      const setItem = Storage.prototype.setItem;
      const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (key === storageKey(failingScope)) throw new Error("quota exceeded");
        setItem.call(this, key, value);
      });
      try { await view.click("继续这次练习"); } finally { save.mockRestore(); }
      expect(currentUrl()).toBe(entryUrl);
      expect(view.host.textContent).toContain("本次题组：3");
      expect(storedCollection(scope)).toMatchObject({ activeId: original.id, drafts: [original, archived] });
      expect(storedCollection(targetScope)).toMatchObject({ activeId: existingTarget.id, drafts: [existingTarget] });
    }

    await view.click("继续这次练习");
    expect(view.host.textContent).toContain("本次题组：4");
    expect(view.answer()).toBe("[[2]]");
    expect(currentUrl()).toBe(entryUrl.replace("variant=2", "variant=3"));
    expect(storedCollection(scope)).toMatchObject({ activeId: original.id, drafts: [original] });
    expect(storedCollection(targetScope)).toMatchObject({
      activeId: archived.id, drafts: [existingTarget, { ...archived, scope: targetScope }],
    });

    if (!editBeforeReopen) {
      await view.open();
      expect(view.host.textContent).toContain("本次题组：4");
      expect(view.answer()).toBe("[[2]]");
      expect(storedCollection(targetScope)?.activeId).toBe(archived.id);
    }

    const sessionId = crypto.randomUUID(), attemptId = crypto.randomUUID();
    client.createSession.mockResolvedValue({ id: sessionId });
    client.createAttempt.mockResolvedValue({
      id: attemptId, courseId, sessionId, sourceIds: [sourceId],
      matrixExercise: createMatrixExerciseSpec(target.exerciseKey, target.variant),
    });
    client.getAttempt.mockResolvedValue({ attemptId, sessionId, deliveredAssistance: "none" });
    client.listObservations.mockResolvedValue([]);
    await view.click("继续此练习");
    await act(async () => {
      const input = view.host.querySelector<HTMLTextAreaElement>("fieldset textarea:not([readonly])");
      expect(input).not.toBeNull();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "[[3]]");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(view.answer()).toBe("[[3]]");
    expect(storedCollection(targetScope)?.drafts.find(draft => draft.id === archived.id)?.fields.answer).toBe("[[3]]");
    expect(storedCollection(scope)?.drafts).toEqual([original]);

    await view.open();
    expect(view.answer()).toBe("[[3]]");
    expect(storedCollection(targetScope)?.activeId).toBe(archived.id);
  } finally { await view.cleanUp(); }
});

it("restores a variant from the course matrix lesson URL and reopens the same draft", async () => {
  const courseId = crypto.randomUUID(), sourceId = crypto.randomUUID();
  const scope = practiceScope(courseId, "matrix");
  const original = emptyPracticeDraft(scope, { sourceId, matrixVariant: 0, answer: "[[1]]" });
  const archived = emptyPracticeDraft(scope, { sourceId, matrixVariant: 3, answer: "[[2]]" });
  archived.start = {
    sessionId: null, clientKey: `matrix-start:${crypto.randomUUID()}`, createInput: null,
    sessionInput: { courseId, sourceIds: [sourceId], skillLabel: "矩阵乘法" },
  };
  initializePracticeDraft(archived);
  switchPracticeDraft(scope, archived.id, original, sessionStorage);
  const view = studyEntry(courseId);
  try {
    window.history.replaceState(null, "", `/opening/courses/${courseId}/study?mode=matrix&exercise=multiplication`);
    await view.open();
    expect(view.host.textContent).toContain("本次题组：1");
    expect(new URLSearchParams(window.location.search).get("variant")).toBeNull();

    await view.click("继续这次练习");
    expect(new URLSearchParams(window.location.search).get("variant")).toBe("3");
    expect(view.host.textContent).toContain("本次题组：4");
    expect(view.answer()).toBe("[[2]]");

    await view.open();
    expect(view.host.textContent).toContain("本次题组：4");
    expect(view.answer()).toBe("[[2]]");
    expect(storedCollection(scope)).toMatchObject({ activeId: archived.id, drafts: [archived, original] });
  } finally { await view.cleanUp(); }
});
