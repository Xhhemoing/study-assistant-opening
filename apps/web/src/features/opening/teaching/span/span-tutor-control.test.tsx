// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpeningAdaptivePrefsResponse, SpanTutorGrant } from "@aistudy/contracts";
const state = vi.hoisted(() => ({ account: vi.fn(), effective: vi.fn() }));
vi.mock("../../courses/course-state-client", () => ({ createCourseStateClient: () => ({ getAccountPreferences: state.account, getPreferences: state.effective }) }));
vi.mock("../../v3/motion/view-transition", () => ({ TransitionLink: "a" }));
import { SpanTutorControl } from "./span-tutor-control";
const courseId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const switches = { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true, autoGradeOnSave: true };
const grant: SpanTutorGrant = { enabled: true, dailyMinutes: 45, revision: 3, confirmedAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", expiresOn: null };
function response(current?: SpanTutorGrant): OpeningAdaptivePrefsResponse {
  return { saved: true, invalidStoredPrefs: false, prefs: { autonomy: "copilot", coachBudgetMinutes: 60, courseGoals: { [courseId]: { targetDate: null, weeklyMinutes: 140 } }, spanTutorGrants: { [otherId]: grant, ...(current ? { [courseId]: current } : {}) } } };
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  window.sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.account.mockResolvedValue(switches); state.effective.mockResolvedValue(switches);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ course: { id: courseId, archivedAt: null } })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function render(current?: SpanTutorGrant) {
  const api = { getAdaptivePrefs: vi.fn(async () => response(current)), patchAdaptivePrefs: vi.fn(async () => response({ ...grant, revision: 1, dailyMinutes: 20 })) };
  await act(async () => root.render(<SpanTutorControl courseId={courseId} api={api} />));
  return api;
}
function button(text: string) { const node = [...host.querySelectorAll("button")].find(item => item.textContent === text); if (!node) throw new Error(`missing ${text}`); return node; }
it("keeps a new course grant off without writes and scopes an explicit confirmation to this course", async () => {
  const api = await render();
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("20");
  expect(host.textContent).toContain("每周 140 分钟");
  expect(host.textContent).toContain("本课程的 span");
  expect(host.textContent).toContain("练习与复测共用");
  expect(api.patchAdaptivePrefs).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("确认导师试用设置").click());
  expect(api.patchAdaptivePrefs).toHaveBeenCalledExactlyOnceWith({ spanTutorGrant: { courseId, enabled: true, dailyMinutes: 20, expiresOn: null, expectedRevision: 0 } });
});
it("shows account-off and archived-course limits without enabling their switches", async () => {
  state.account.mockResolvedValue({ ...switches, assessmentEnabled: false, retestSuggestionsEnabled: false });
  state.effective.mockResolvedValue({ ...switches, assessmentEnabled: false, retestSuggestionsEnabled: false });
  vi.mocked(fetch).mockResolvedValue(Response.json({ course: { id: courseId, archivedAt: "2026-10-26T00:00:00Z" } }));
  const api = await render(grant);
  expect(host.textContent).toContain("账号自动评价：关闭");
  expect(host.textContent).toContain("账号补测建议：关闭");
  expect(host.textContent).toContain("课程已归档");
  expect((button("确认导师试用设置") as HTMLButtonElement).disabled).toBe(true);
  expect(api.patchAdaptivePrefs).not.toHaveBeenCalled();
});
it("blocks retries after an unknown write until an explicit read establishes the current revision", async () => {
  const api = await render(grant);
  api.patchAdaptivePrefs.mockRejectedValueOnce(new Error("connection lost"));
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("确认导师试用设置").click());
  expect(host.textContent).toContain("保存结果未确认");
  expect((button("确认导师试用设置") as HTMLButtonElement).disabled).toBe(true);
  api.getAdaptivePrefs.mockResolvedValue(response({ ...grant, enabled: false, revision: 4 }));
  await act(async () => button("重新读取授权").click());
  expect(host.textContent).toContain("当前授权版本：4");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  expect(api.patchAdaptivePrefs).toHaveBeenCalledTimes(1);
});
it("lets an existing grant be turned off using its displayed revision", async () => {
  const api = await render(grant);
  api.patchAdaptivePrefs.mockResolvedValue(response({ ...grant, enabled: false, revision: 4 }));
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("确认导师试用设置").click());
  expect(api.patchAdaptivePrefs).toHaveBeenCalledExactlyOnceWith({ spanTutorGrant: { courseId, enabled: false, dailyMinutes: 45, expiresOn: null, expectedRevision: 3 } });
  expect(host.textContent).toContain("当前授权版本：4");
});

it("uses 30 only when no course budget exists and never borrows another course grant", async () => {
  const prefs = response(); prefs.prefs.courseGoals = {};
  const api = { getAdaptivePrefs: vi.fn(async () => prefs), patchAdaptivePrefs: vi.fn() };
  await act(async () => root.render(<SpanTutorControl courseId={courseId} api={api} />));
  expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("30");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  expect(api.patchAdaptivePrefs).not.toHaveBeenCalled();
});

it.each(["course", "preferences"])("blocks a new grant after the %s read fails instead of saving an invented disabled state", async failure => {
  if (failure === "course") vi.mocked(fetch).mockRejectedValue(new Error("offline"));
  const prefs = response(); prefs.invalidStoredPrefs = failure === "preferences";
  const api = { getAdaptivePrefs: vi.fn(async () => prefs), patchAdaptivePrefs: vi.fn() };
  await act(async () => root.render(<SpanTutorControl courseId={courseId} api={api} />));
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect((button("确认导师试用设置") as HTMLButtonElement).disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(api.patchAdaptivePrefs).not.toHaveBeenCalled();
});

it("retains a chosen expiration and refuses to treat a missing receipt as confirmation", async () => {
  const api = await render(grant);
  const date = host.querySelector<HTMLInputElement>('input[type="date"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(date, "2026-12-01");
    date.dispatchEvent(new Event("input", { bubbles: true }));
  });
  api.patchAdaptivePrefs.mockResolvedValue(response());
  await act(async () => button("确认导师试用设置").click());
  expect(api.patchAdaptivePrefs).toHaveBeenCalledExactlyOnceWith({ spanTutorGrant: { courseId, enabled: true, dailyMinutes: 45, expiresOn: "2026-12-01", expectedRevision: 3 } });
  expect(host.textContent).toContain("保存结果未确认");
  expect(date.value).toBe("2026-12-01");
});

it("keeps an uncertain enable unresolved when a read still sees the pre-commit revision", async () => {
  const api = await render();
  api.patchAdaptivePrefs.mockRejectedValueOnce(new Error("response lost while transaction continues"));
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("确认导师试用设置").click());
  await act(async () => button("重新读取授权").click());
  expect(host.querySelector("summary")?.textContent).toContain("授权保存待确认");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect((button("确认导师试用设置") as HTMLButtonElement).disabled).toBe(true);
  expect(button("重新确认原授权")).not.toBeNull();
  // The original transaction commits after the stale GET, without any new UI write.
  api.getAdaptivePrefs.mockResolvedValue(response({ ...grant, revision: 1, dailyMinutes: 20 }));
  await act(async () => button("重新读取授权").click());
  expect(host.querySelector("summary")?.textContent).toContain("已保存开启");
  expect(host.querySelector("summary")?.textContent).not.toContain("待确认");
  expect(api.patchAdaptivePrefs).toHaveBeenCalledTimes(1);
});

it("retries an unresolved grant with the original CAS revision and exact fields after a stale read", async () => {
  const api = await render();
  api.patchAdaptivePrefs.mockRejectedValueOnce(new Error("response lost"));
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("确认导师试用设置").click());
  await act(async () => button("重新读取授权").click());
  api.patchAdaptivePrefs.mockResolvedValue(response({ ...grant, revision: 1, dailyMinutes: 20 }));
  await act(async () => button("重新确认原授权").click());
  expect(api.patchAdaptivePrefs.mock.calls[1]).toEqual(api.patchAdaptivePrefs.mock.calls[0]);
  expect(host.querySelector("summary")?.textContent).toContain("已保存开启");
});

it("restores an uncertain CAS command after unmount while the server still exposes its old revision", async () => {
  const api = await render();
  api.patchAdaptivePrefs.mockRejectedValueOnce(new Error("response lost"));
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("确认导师试用设置").click());
  await act(async () => root.render(null));
  await act(async () => root.render(<SpanTutorControl courseId={courseId} api={api} />));
  expect(host.querySelector("summary")?.textContent).toContain("授权保存待确认");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  api.patchAdaptivePrefs.mockResolvedValue(response({ ...grant, revision: 1, dailyMinutes: 20 }));
  await act(async () => button("重新确认原授权").click());
  expect(api.patchAdaptivePrefs.mock.calls[1]).toEqual(api.patchAdaptivePrefs.mock.calls[0]);
});

it("keeps course A's pending request when the same component visits B and returns to A", async () => {
  const api = await render();
  api.patchAdaptivePrefs.mockRejectedValueOnce(new Error("response lost"));
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("确认导师试用设置").click());
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ course: { id: otherId, archivedAt: null } }));
  await act(async () => root.render(<SpanTutorControl courseId={otherId} api={api} />));
  expect(host.querySelector("summary")?.textContent).not.toContain("待确认");
  await act(async () => root.render(<SpanTutorControl courseId={courseId} api={api} />));
  expect(host.querySelector("summary")?.textContent).toContain("授权保存待确认");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(api.patchAdaptivePrefs).toHaveBeenCalledTimes(1);
});

it("preserves unknown consent in memory when storage writes fail and keeps the refresh limitation visible", async () => {
  const denied = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage disabled"); });
  const api = await render();
  api.patchAdaptivePrefs.mockRejectedValueOnce(new Error("response lost"));
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("确认导师试用设置").click());
  await act(async () => root.render(null));
  await act(async () => root.render(<SpanTutorControl courseId={courseId} api={api} />));
  expect(host.querySelector("summary")?.textContent).toContain("授权保存待确认");
  expect(host.textContent).toContain("刷新或关闭后将无法找回这次待确认的授权");
  api.patchAdaptivePrefs.mockResolvedValue(response({ ...grant, revision: 1, dailyMinutes: 20 }));
  await act(async () => button("重新确认原授权").click());
  expect(api.patchAdaptivePrefs.mock.calls[1]).toEqual(api.patchAdaptivePrefs.mock.calls[0]);
  denied.mockRestore();
});
