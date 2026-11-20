// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { parseCourseStudyPracticeEntry } from "../courses/course-study-query";
import { LearningAttemptForm } from "./attempt-form";
import { emptyPracticeDraft, parsePracticeDraftCollection, practiceScope, writePracticeDraft } from "./practice-draft";

const client = vi.hoisted(() => ({
  getSummary: async () => [], createSession: vi.fn(), createAttempt: vi.fn(), getAttempt: vi.fn(), listObservations: vi.fn(),
  submitAttempt: vi.fn(), getObservationHistory: vi.fn(),
}));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => client }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => ({ listSources: async () => [] }) }));

it("keeps a requested matrix entry disabled until the outer draft has been read", () => {
  const html = renderToStaticMarkup(createElement(LearningAttemptForm, { courseId: "course", initialMode: "matrix", initialMatrixKey: "multiplication", initialMatrixVariant: 1, onRecorded() {} }));
  expect(html).toContain("正在恢复练习");
  expect(html).toContain('<fieldset disabled=""');
  expect(html).not.toContain("开始矩阵练习");
});

it("starts pasted questions with a saved problem even when no source is selected", async () => {
  const { practiceQuestionInput } = await import("./attempt-form");
  expect(practiceQuestionInput("  计算 17 × 23  ", "")).toEqual({ stemSnapshot: "计算 17 × 23", artifactKind: "reference_item" });
  expect(practiceQuestionInput("题目", "source-id")).toEqual({ sourceId: "source-id", stemSnapshot: "题目", artifactKind: "reference_item" });
  expect(practiceQuestionInput(" ", "")).toBeUndefined();
});

it.each(["submit", "archive then submit another"] as const)("recovers a legacy manual answer and keeps it out of the active form after %s", async action => {
  const courseId = crypto.randomUUID(), sessionId = crypto.randomUUID(), attemptId = crypto.randomUUID();
  const scope = practiceScope(courseId, "ordinary");
  const clientKey = "legacy-manual-attempt";
  const skillLabel = "手动练习";
  const draft = {
    ...emptyPracticeDraft(scope, { skillLabel, answer: "升级前的答案" }),
    start: { clientKey, sessionId, sessionInput: { courseId, sourceIds: [], skillLabel }, createInput: { sessionId, clientKey } },
    attemptId,
  };
  const matrix = emptyPracticeDraft(scope, { matrixMode: true, skillLabel: "已归档的矩阵题", answer: "矩阵原答案" });
  const storageKey = `opening-practice:v2:${scope}`;
  sessionStorage.setItem(storageKey, JSON.stringify({ version: 2, scope, activeId: draft.id, drafts: action === "submit" ? [matrix, draft] : [draft] }));
  const attempt: LearningAttempt = {
    id: attemptId, workspaceId: courseId, courseId, sessionId, skillLabel, requirementKey: null,
    sourceIds: [], sourceVersions: {}, problemId: null, itemVersionId: null, observationId: null,
    submittedAt: null, startedAt: "2026-11-20T00:00:00Z", historyRevision: 0,
  };
  const observation: LearningObservation = {
    id: crypto.randomUUID(), workspaceId: courseId, courseId, sessionId, attemptId, skillLabel,
    sourceIds: [], outcome: "unverified", assistance: "unknown", verdictSource: "self_report",
    answer: "修改后的答案", occurredAt: "2026-11-20T00:00:00Z", clientKey: "legacy-manual-answer",
    sourceTurnIds: [], referenceSourceId: null, evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
  };
  client.createAttempt.mockResolvedValue(attempt);
  client.getAttempt.mockResolvedValue({ attemptId, sessionId, deliveredAssistance: "none" });
  client.listObservations.mockResolvedValue([]);
  client.submitAttempt.mockResolvedValue(observation);
  client.getObservationHistory.mockResolvedValue({ rootObservationId: observation.id, headObservationId: observation.id, revisions: [observation] });

  const host = document.createElement("div");
  const root = createRoot(host);
  const originalUrl = window.location.href;
  window.history.replaceState(null, "", `/opening/courses/${courseId}/study?mode=practice`);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const open = () => act(async () => root.render(createElement(LearningAttemptForm, {
    courseId, ...parseCourseStudyPracticeEntry(Object.fromEntries(new URLSearchParams(window.location.search))),
    onRecorded() {}, onAskAttempt() {},
  })));
  const answerField = () => host.querySelector<HTMLTextAreaElement>("fieldset textarea");
  const click = (label: string) => act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click());
  const enter = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = () => act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const reopen = async () => { await act(async () => root.render(null)); await open(); };
  try {
    await open();
    expect(answerField()?.value).toBe("升级前的答案");
    if (action === "submit") {
      expect(host.textContent).not.toContain("未完成的练习（");
      expect([...host.querySelectorAll("textarea")].map(input => input.value)).not.toContain("矩阵原答案");
      expect(parsePracticeDraftCollection(JSON.parse(sessionStorage.getItem(storageKey)!), scope))
        .toMatchObject({ activeId: matrix.id, drafts: [matrix] });
    }
    await click("继续此练习");
    await enter(answerField()!, observation.answer!);
    await reopen();
    expect(answerField()?.value).toBe("修改后的答案");

    if (action === "archive then submit another") {
      await click("保留答案，开始其他练习");
      const newAttempt = { ...attempt, id: crypto.randomUUID(), sessionId: crypto.randomUUID(), skillLabel: "新练习" };
      const newObservation = { ...observation, id: crypto.randomUUID(), attemptId: newAttempt.id, sessionId: newAttempt.sessionId, skillLabel: newAttempt.skillLabel, answer: "新练习答案" };
      client.createSession.mockResolvedValueOnce({ id: newAttempt.sessionId });
      client.createAttempt.mockResolvedValueOnce(newAttempt);
      client.getAttempt.mockResolvedValueOnce({ attemptId: newAttempt.id, sessionId: newAttempt.sessionId, deliveredAssistance: "none" });
      client.getAttempt.mockResolvedValueOnce({ attemptId: newAttempt.id, sessionId: newAttempt.sessionId, deliveredAssistance: "none" });
      client.submitAttempt.mockResolvedValueOnce(newObservation);
      client.getObservationHistory.mockResolvedValueOnce({ rootObservationId: newObservation.id, headObservationId: newObservation.id, revisions: [newObservation] });
      await enter(host.querySelector('fieldset input[list^="opening-skill-labels-"]')!, newAttempt.skillLabel);
      await submit();
      await enter(answerField()!, newObservation.answer);
      await submit();
      expect(client.submitAttempt).toHaveBeenLastCalledWith(newAttempt.id, expect.objectContaining({ answer: "新练习答案" }));
      await reopen();
      expect(host.querySelector("details textarea[readonly]")).not.toBeNull();
      expect(host.querySelector<HTMLTextAreaElement>("details textarea")?.value).toBe("修改后的答案");
      await click("继续这次练习");
      expect(answerField()?.value).toBe("修改后的答案");
    }

    await click("继续此练习");
    await submit();
    expect(host.textContent).toContain("原答案已保存");
    expect(client.submitAttempt).toHaveBeenLastCalledWith(attemptId, expect.objectContaining({ answer: observation.answer }));
    await reopen();
    expect(host.querySelector('fieldset input[list^="opening-skill-labels-"]')).not.toBeNull();
    expect(host.textContent).not.toContain("已找回未完成的练习");
    expect([...host.querySelectorAll("textarea")].map(input => input.value)).not.toContain("修改后的答案");
    if (action === "submit") {
      expect(parsePracticeDraftCollection(JSON.parse(sessionStorage.getItem(storageKey)!), scope))
        .toMatchObject({ activeId: matrix.id, drafts: [matrix] });
    } else {
      expect(sessionStorage.getItem(storageKey)).toBeNull();
    }
  } finally {
    await act(async () => root.unmount());
    window.history.replaceState(null, "", originalUrl);
    vi.unstubAllGlobals();
    sessionStorage.clear();
  }
});

it("opens explicit manual practice and preserves the saved ordinary matrix mode draft", async () => {
  const courseId = crypto.randomUUID();
  const scope = practiceScope(courseId, "ordinary");
  writePracticeDraft(emptyPracticeDraft(scope, { matrixMode: true, skillLabel: "已保存的练习" }), sessionStorage);
  const storageKey = `opening-practice:v2:${scope}`;
  const original = sessionStorage.getItem(storageKey);
  expect(original).toBeTruthy();
  const practiceEntry = parseCourseStudyPracticeEntry({ mode: "practice" });
  const host = document.createElement("div");
  const root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const open = () => act(async () => root.render(createElement(LearningAttemptForm, { courseId, ...practiceEntry, onRecorded() {} })));
  const topic = () => host.querySelector<HTMLInputElement>('input[list^="opening-skill-labels-"]');
  try {
    await open();
    expect(host.textContent).not.toContain("开始矩阵练习");
    expect(topic()?.disabled).toBe(false);
    expect(topic()?.value).toBe("");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(topic(), "自选练习主题");
      topic()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => root.render(null));
    await open();
    expect(topic()?.value).toBe("自选练习主题");
    expect(sessionStorage.getItem(storageKey)).toBe(original);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    sessionStorage.clear();
  }
});

it("shares manual inputs between the default entry and explicit practice while keeping the matrix entry available", async () => {
  const courseId = crypto.randomUUID();
  const host = document.createElement("div");
  const root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const open = (initialMode?: "practice") => act(async () => root.render(createElement(LearningAttemptForm, { courseId, initialMode, onRecorded() {} })));
  const topic = () => host.querySelector<HTMLInputElement>('input[list^="opening-skill-labels-"]')!;
  const click = (label: string) => act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click());
  try {
    await open();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(topic(), "普通入口的主题");
      topic().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("练习内置矩阵题（自动核算）");
    expect(host.textContent).toContain("内置矩阵练习");
    await click("返回普通练习");
    expect(topic().value).toBe("普通入口的主题");
    await open("practice");
    expect(topic().value).toBe("普通入口的主题");
    expect(host.textContent).not.toContain("练习内置矩阵题（自动核算）");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    sessionStorage.clear();
  }
});
