// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { LearningPreferences } from "@aistudy/contracts";
vi.mock("../opening/timetable/semester-settings-form", () => ({ SemesterSettingsForm: () => null }));
vi.mock("../opening/timetable/timetable-import", () => ({ TimetableImport: () => null }));
vi.mock("../opening/teaching/preference-controls", () => ({ PreferenceControls: () => null }));
vi.mock("./quick-setup-panel", () => ({ QuickSetupPanel: () => null }));
vi.mock("../opening/settings/appearance-settings", () => ({ AppearanceSettings: () => null }));
vi.mock("../opening/v3/motion/view-transition", () => ({ TransitionLink: "a" }));
import { SettingsView } from "./settings-view";

it("persists OFF across assessment shutdown, other preference changes and reload; auto grading remains independently editable", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let stored: LearningPreferences = { autoGradeOnSave: true, assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true };
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") stored = JSON.parse(String(init.body)).learningPreferences;
    return { ok: true, json: async () => ({ learningPreferences: { ...stored } }) };
  });
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div"), root = createRoot(container);
  document.body.append(container);
  const toggle = async (label: string) => {
    const input = [...container.querySelectorAll("label")].find(row => row.textContent === label)?.querySelector("input");
    expect(input).toBeTruthy(); expect(input!.disabled).toBe(false);
    await act(async () => input!.click());
  };
  const save = async () => { await act(async () => [...container.querySelectorAll("button")].find(row => row.textContent?.includes("保存学习偏好"))!.click()); };
  try {
    await act(async () => root.render(createElement(SettingsView)));
    await toggle("首次提交自动批改（工作区）"); await save();
    expect(stored.autoGradeOnSave).toBe(false);
    await toggle("自动评价"); await save();
    expect(stored).toEqual({ autoGradeOnSave: false, assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
    await toggle("自动评价"); await toggle("补测建议"); await save();
    expect(stored.autoGradeOnSave).toBe(false); expect(stored.retestSuggestionsEnabled).toBe(true);
    await act(async () => root.render(null)); await act(async () => root.render(createElement(SettingsView)));
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    await toggle("自动评价"); await toggle("首次提交自动批改（工作区）"); await save();
    expect(stored.autoGradeOnSave).toBe(true); expect(stored.assessmentEnabled).toBe(false);
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
