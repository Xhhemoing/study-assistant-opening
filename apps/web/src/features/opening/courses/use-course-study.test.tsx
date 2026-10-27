// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCourseStudy } from "./use-course-study";
import type { OpeningApi } from "../client/api";

it("loads basic goals with teaching/adaptive features off and does not turn invalid prefs into an empty goal", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const goal = { targetDate: "2026-10-31", weeklyMinutes: 420 };
  const getAdaptivePrefs = vi.fn().mockResolvedValue({ prefs: { courseGoals: { course: goal } }, invalidStoredPrefs: false });
  const listTeachingActivities = vi.fn(), listTasks = vi.fn();
  const getPlanningSettings = vi.fn().mockResolvedValue({ settings: { timeZone: "America/Los_Angeles" }, invalidStoredSettings: false });
  const api = { getAdaptivePrefs, listTeachingActivities, listTasks, getPlanningSettings } as unknown as OpeningApi;
  function Probe({ courseId = "course" }: { courseId?: string }) {
    const study = useCourseStudy(courseId, api, false);
    return <p>{JSON.stringify({ goal: study.goal, timeZone: study.timeZone, error: study.taskError })}</p>;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toContain('"weeklyMinutes":420');
    expect(getAdaptivePrefs).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("America/Los_Angeles");
    expect(listTeachingActivities).not.toHaveBeenCalled(); expect(listTasks).not.toHaveBeenCalled();
    getAdaptivePrefs.mockResolvedValue({ prefs: { courseGoals: {} }, invalidStoredPrefs: true });
    await act(async () => root.render(<Probe courseId="other" />));
    expect(host.textContent).toContain("目标摘要暂时无法读取");
    expect(host.textContent).not.toContain("420");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
