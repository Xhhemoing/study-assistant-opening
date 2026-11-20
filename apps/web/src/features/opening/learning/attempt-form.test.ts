// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { parseCourseStudyPracticeEntry } from "../courses/course-study-query";
import { LearningAttemptForm } from "./attempt-form";
import { emptyPracticeDraft, practiceScope, writePracticeDraft } from "./practice-draft";

const client = vi.hoisted(() => ({
  getSummary: async () => [], createAttempt: vi.fn(), getAttempt: vi.fn(), listObservations: vi.fn(),
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

it.each(["submit", "start another"] as const)("recovers a legacy manual answer and keeps it out of the active form after %s", async action => {
  const courseId = crypto.randomUUID(), sessionId = crypto.randomUUID(), attemptId = crypto.randomUUID();
  const scope = practiceScope(courseId, "ordinary");
  const clientKey = "legacy-manual-attempt";
  const skillLabel = "手动练习";
  const draft = {
    ...emptyPracticeDraft(scope, { skillLabel, answer: "升级前的答案" }),
    start: { clientKey, sessionId, sessionInput: { courseId, sourceIds: [], skillLabel }, createInput: { sessionId, clientKey } },
    attemptId,
  };
  sessionStorage.setItem(`opening-practice:v2:${scope}`, JSON.stringify({ version: 2, scope, activeId: draft.id, drafts: [draft] }));
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
  try {
    await open();
    expect(answerField()?.value).toBe("升级前的答案");
    await click("继续此练习");
    await act(async () => {
      const input = answerField()!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, observation.answer);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => root.render(null));
    await open();
    expect(answerField()?.value).toBe("修改后的答案");

    if (action === "submit") {
      await click("继续此练习");
      await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(host.textContent).toContain("原答案已保存");
      expect(client.submitAttempt).toHaveBeenLastCalledWith(attemptId, expect.objectContaining({ answer: observation.answer }));
    } else {
      await click("保留答案，开始其他练习");
    }
    await act(async () => root.render(null));
    await open();
    expect(host.querySelector('fieldset input[list^="opening-skill-labels-"]')).not.toBeNull();
    expect(host.querySelector("fieldset")?.textContent).not.toContain("已找回未完成的练习");
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
