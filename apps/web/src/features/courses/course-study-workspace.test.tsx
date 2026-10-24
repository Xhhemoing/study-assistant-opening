// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpeningApi } from "../opening/client/api";
import type { TeachingActivity } from "@aistudy/contracts";

const data = vi.hoisted(() => ({
  course: { id: "11111111-1111-4111-8111-111111111111", title: "线性代数", archivedAt: null },
  activity: { id: "22222222-2222-4222-8222-222222222222", courseId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "33333333-3333-4333-8333-333333333333", ownerUserId: "44444444-4444-4444-8444-444444444444",
    status: "active", generateStatus: "ready", contentVersion: 1, pathVersion: 1, intentKind: "goal", intentSummary: "矩阵",
    sourceIds: [], clientKey: "test:course-study", createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z" } satisfies TeachingActivity,
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
import { openCourseStudy } from "./course-study-entry";

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

it("waits for task admission before requesting the bound activity checkpoint", async () => {
  let admit!: () => void;
  vi.mocked(openCourseStudy).mockImplementationOnce(() => new Promise(resolve => {
    admit = () => resolve({ kind: "activity", activity: data.activity });
  }));
  const getTeachingResume = vi.fn(async () => ({ activityId: data.activity.id, status: "active", generateStatus: "ready",
    contentVersion: 1, pathVersion: 1, clientInit: {}, gates: { materials: "available" } }));
  const api = { getTeachingResume } as unknown as OpeningApi;
  const taskId = "33333333-3333-4333-8333-333333333333";
  await act(async () => root.render(createElement(CourseStudyWorkspace, { courseId: data.course.id, activityId: data.activity.id,
    taskId, teachingEnabled: true, teachingCompileEnabled: false, sourceIds: [], timeZone: "Asia/Shanghai", api })));
  expect(openCourseStudy).toHaveBeenCalledWith(api, expect.objectContaining({ activityId: data.activity.id, taskId }));
  expect(getTeachingResume).not.toHaveBeenCalled();
  expect(data.teachingMount).not.toHaveBeenCalled();
  await act(async () => admit());
  expect(getTeachingResume).toHaveBeenCalledExactlyOnceWith(data.activity.id);
  expect(data.teachingMount).toHaveBeenCalledOnce();
});

it("does not request a checkpoint or mount teaching after task admission fails", async () => {
  vi.mocked(openCourseStudy).mockRejectedValueOnce(new Error("任务目标已变化"));
  const getTeachingResume = vi.fn();
  await act(async () => root.render(createElement(CourseStudyWorkspace, { courseId: data.course.id, activityId: data.activity.id,
    taskId: "33333333-3333-4333-8333-333333333333", teachingEnabled: true, teachingCompileEnabled: true,
    sourceIds: [], timeZone: "Asia/Shanghai", api: { getTeachingResume } as unknown as OpeningApi })));
  expect(host.textContent).toContain("任务目标已变化");
  expect(getTeachingResume).not.toHaveBeenCalled();
  expect(data.teachingMount).not.toHaveBeenCalled();
  expect(data.practiceMount).not.toHaveBeenCalled();
});
