// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { parseCourseStudyPracticeEntry } from "../courses/course-study-query";
import { LearningAttemptForm } from "./attempt-form";
import { emptyPracticeDraft, practiceScope, writePracticeDraft } from "./practice-draft";

vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => ({ getSummary: async () => [] }) }));
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
