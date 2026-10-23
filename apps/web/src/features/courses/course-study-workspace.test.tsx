// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpeningApi } from "../opening/client/api";

const data = vi.hoisted(() => ({
  course: { id: "11111111-1111-4111-8111-111111111111", title: "线性代数", archivedAt: null },
  activity: { id: "22222222-2222-4222-8222-222222222222", status: "active", generateStatus: "ready", contentVersion: 1, pathVersion: 1 },
  teachingMount: vi.fn(), practiceMount: vi.fn(),
}));
vi.mock("./course-detail", () => ({ useCourseBundle: () => ({ course: data.course, loading: false, error: null, reload: vi.fn() }) }));
vi.mock("./course-study-entry", () => ({ openCourseStudy: vi.fn(async () => ({ kind: "activity", activity: data.activity })) }));
vi.mock("./course-study-context-tools", () => ({ CourseStudyContextTools: () => null }));
vi.mock("./course-study-materials", () => ({ CourseStudyMaterials: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../opening/teaching/teaching-workspace", () => ({ TeachingContinueEntry: () => {
  useEffect(() => { data.teachingMount(); }, []);
  return createElement("textarea", { "aria-label": "讲解原答", defaultValue: "讲解中的步骤" });
} }));
vi.mock("../opening/learning/attempt-form", () => ({ LearningAttemptForm: () => {
  useEffect(() => { data.practiceMount(); }, []);
  return createElement("textarea", { "aria-label": "练习原答", defaultValue: "" });
} }));

import { CourseStudyWorkspace } from "./course-study-workspace";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    media, matches: false, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
  await act(async () => button.click());
}

it("lazily opens independent practice and keeps both real work surfaces mounted when returning", async () => {
  const api = { getTeachingResume: vi.fn(async () => ({ activityId: data.activity.id, status: "active", generateStatus: "ready", contentVersion: 1, pathVersion: 1, clientInit: {}, gates: { materials: "available" } })) } as unknown as OpeningApi;
  await act(async () => root.render(createElement(CourseStudyWorkspace, { courseId: data.course.id, teachingEnabled: true,
    teachingCompileEnabled: true, sourceIds: [], timeZone: "Asia/Shanghai", api })));
  const original = host.querySelector<HTMLTextAreaElement>('[aria-label="讲解原答"]')!;
  original.value = "尚未提交的讲解答案";
  expect(data.teachingMount).toHaveBeenCalledOnce();
  expect(data.practiceMount).not.toHaveBeenCalled();
  await click("独立练习");
  const practice = host.querySelector<HTMLTextAreaElement>('[aria-label="练习原答"]')!;
  practice.value = "我的新解答";
  expect(original.closest("[hidden]")).not.toBeNull();
  await click("返回讲解");
  expect(host.querySelector('[aria-label="讲解原答"]')).toBe(original);
  expect(original.value).toBe("尚未提交的讲解答案");
  expect(practice.closest("[hidden]")).not.toBeNull();
  await click("独立练习");
  expect(host.querySelector('[aria-label="练习原答"]')).toBe(practice);
  expect(practice.value).toBe("我的新解答");
  expect(data.teachingMount).toHaveBeenCalledOnce();
  expect(data.practiceMount).toHaveBeenCalledOnce();
  expect(api.getTeachingResume).toHaveBeenCalledOnce();
});
