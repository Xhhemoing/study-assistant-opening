// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { OpeningApi } from "../client/api";
import type { TodayResumeState } from "./today-read";

const { openAssistant } = vi.hoisted(() => ({ openAssistant: vi.fn() }));
vi.mock("../assistant/assistant-entry", async () => ({ ...await vi.importActual("../assistant/assistant-entry"), openAssistantDrawer: openAssistant }));
vi.mock("./today-progress", () => ({ TodayProgress: () => <div aria-label="今天的进度"><a href="/opening/review">复习</a></div> }));
vi.mock("./today-view", async () => {
  const actual = await vi.importActual<typeof import("./today-view")>("./today-view");
  return { ...actual, TodayPlanView: ({ reloadToken, onSelect }: { reloadToken: number; onSelect: (task: unknown) => void }) => <div data-queue-revision={reloadToken}><button type="button" onClick={() => onSelect({ id: "task", title: "线性代数" })}>选择任务</button></div> };
});
vi.mock("../teaching/teaching-workspace", async () => {
  const actual = await vi.importActual<typeof import("../teaching/teaching-workspace")>("../teaching/teaching-workspace");
  return { ...actual, TeachingContinueEntry: () => <div data-inline-lesson="true">已打开学习内容</div> };
});
import { TodayDashboard } from "./today-dashboard";
import { ReviewView } from "./review-view";

const id = "11111111-1111-4111-8111-111111111111";
const state: TodayResumeState = { kind: "ready", courses: { status: "ready", items: [{ id: "course", title: "线性代数", archivedAt: null }] }, pendingReviews: { count: 1, href: "/opening/suggestions" } };
const candidate = { id, status: "pending", sourceIds: [], version: 0, candidate: { kind: "task", title: "练习线性方程", minutes: 20, dueText: null } };
const activity = { id, courseId: null as string | null, intentSummary: "线性代数第一节", status: "active", generateStatus: "queued", contentVersion: 0 };
function makeApi() {
  return { listTeachingActivities: vi.fn(async () => [activity]), getTeachingResume: vi.fn(async () => ({ clientInit: null })),
    listCandidates: vi.fn(async () => [candidate]), listRetestCandidates: vi.fn(async () => []), listSources: vi.fn(async () => []),
    createTask: vi.fn(), discardCandidate: vi.fn(), acceptRetest: vi.fn(), decideMemoryCandidate: vi.fn() };
}
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; window.history.replaceState(null, "", "/"); vi.unstubAllGlobals(); openAssistant.mockClear(); });
async function render(api: ReturnType<typeof makeApi>, extra: Partial<Parameters<typeof TodayDashboard>[0]> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); host.className = "group/workspace"; host.dataset.focus = "false"; document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(createElement(TodayDashboard, { state, api: api as unknown as OpeningApi, teachingLoopTrialEnabled: true, ...extra })));
  return host;
}
function button(host: Element, text: string) { const found = [...host.querySelectorAll("button")].find(node => node.textContent === text); if (!found) throw new Error(`missing ${text}`); return found; }
function visibleControls(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>('button,a[href],summary,input,select,textarea,[tabindex]')].filter(control => {
    if (control.hasAttribute("disabled")) return false;
    for (let node: HTMLElement | null = control; node && node !== host; node = node.parentElement) {
      if (node.hidden || node.classList.contains("hidden")) return false;
      if (host.dataset.focus === "true" && node.classList.contains("group-data-[focus=true]/workspace:hidden")) return false;
      if (node instanceof HTMLDetailsElement && !node.open && !node.querySelector(":scope > summary")?.contains(control)) return false;
    }
    return true;
  });
}

it("keeps one next action without mounting planning or suggestion requests on Today", async () => {
  const api = makeApi();
  const host = await render(api);
  expect(host.querySelectorAll('[data-continue-card="true"]')).toHaveLength(1);
  expect(host.querySelector('[data-inline-lesson]')).toBeNull();
  expect(host.querySelector("#today-queue")).toBeNull();
  expect(host.querySelector("#suggestions")).toBeNull();
  expect(api.listCandidates).not.toHaveBeenCalled();
  const main = host.querySelector('[data-today-primary-cta="true"]')!;
  host.dataset.focus = "true";
  expect(visibleControls(host)).toContain(main);
  host.dataset.focus = "false";
  expect(host.querySelector('a[href="/opening/review"]')).not.toBeNull();
  expect(host.querySelector('a[href="/opening/settings/planning"]')).not.toBeNull();
});

it("shows every existing course and the full course destination within learning", async () => {
  const host = await render(makeApi(), { state: { ...state, courses: { status: "ready", items: [
    { id: "course", title: "线性代数", archivedAt: null },
    { id: "old-course", title: "大学物理", archivedAt: "2026-10-01" },
  ] } } });
  const courses = host.querySelector('[aria-label="我的课程"]');
  expect(courses?.querySelector('a[href="/opening/courses/course"]')?.textContent).toContain("线性代数");
  expect(courses?.querySelector('a[href="/opening/courses/old-course"]')?.textContent).toContain("已归档");
  expect(courses?.querySelector('a[href="/opening/courses?view=all"]')?.textContent).toBe("全部课程");
});

it.each([false, true])("keeps asking in the assistant entry instead of a duplicate learning ask bar (%s)", async noCourses => {
  const host = await render(makeApi(), noCourses ? { state: { kind: "empty", courses: { status: "ready", items: [] } } } : {});
  expect(host.querySelector('input[aria-label="向 AI 提问"]')).toBeNull();
  expect(openAssistant).not.toHaveBeenCalled();
});


it("opens a task deep link and keeps review discoverable even with no course", async () => {
  const host = await render(makeApi(), { planning: true, focusTaskId: "task" });
  expect((host.querySelector("#today-queue") as HTMLElement).hidden).toBe(false);
  const empty = await render(makeApi(), { state: { kind: "empty", courses: { status: "ready", items: [] } } });
  expect(empty.querySelector('a[href="/opening/review"]')).not.toBeNull();
});

it("leaves all proposal decisions to the suggestions page from learning settings", async () => {
  const api = makeApi();
  const host = await render(api, { planning: true });
  expect(host.querySelector("#suggestions")).toBeNull();
  expect(api.listCandidates).not.toHaveBeenCalled();
});

it("preserves an uncertain review request on the suggestions page and notifies only after success", async () => {
  const api = makeApi(); api.createTask.mockRejectedValueOnce(new Error("网络中断"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<ReviewView api={api as unknown as OpeningApi} />));
  const title = host.querySelector<HTMLInputElement>("input")!;
  await act(async () => button(host, "接受建议").click());
  expect(host.textContent).toContain("网络中断");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="重新读取"]')!.click());
  expect(host.querySelector("input")).toBe(title);
  expect(title.value).toBe("练习线性方程");
  api.createTask.mockResolvedValueOnce({ id: "task", title: title.value });
  const changed = vi.fn(); window.addEventListener("opening:reviews-changed", changed);
  try { await act(async () => button(host, "重试接受").click()); } finally { window.removeEventListener("opening:reviews-changed", changed); }
  expect(api.createTask).toHaveBeenCalledTimes(2);
  expect(api.createTask.mock.calls[1]).toEqual(api.createTask.mock.calls[0]);
  expect(changed).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("任务已接受");
});
