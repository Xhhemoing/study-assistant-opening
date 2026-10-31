// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { OpeningCapabilitiesContext } from "../capabilities/capabilities-provider";
import { ObjectConversationContext } from "../assistant/conversation-object-context";
import { CourseDetail } from "./course-detail";

const data = vi.hoisted(() => ({ replace: vi.fn(), mounts: vi.fn(), archived: false, fail: false }));
const conversation = "11111111-1111-4111-8111-111111111111";
const courseId = "55555555-5555-4555-8555-555555555555";
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: data.replace }), useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("./use-course-study", () => ({ useCourseStudy: () => ({ activities: [{ id: "activity-real", courseId: "55555555-5555-4555-8555-555555555555", status: "active", intentSummary: "继续矩阵" }], tasks: [], loading: false, reload: vi.fn() }) }));
vi.mock("./course-goal-form", () => ({ CourseGoalForm: () => {
  const [value, setValue] = useState("");
  return <input aria-label="目标草稿" value={value} onChange={event => setValue(event.target.value)} />;
} }));
vi.mock("../library/library-document-list", () => ({ LibraryDocumentList: () => {
  const [value, setValue] = useState("");
  return <textarea aria-label="笔记草稿" value={value} onChange={event => setValue(event.target.value)} />;
} }));
vi.mock("./course-settings-panel", () => ({ CourseSettingsPanel: () => <input aria-label="设置草稿" /> }));
vi.mock("./course-add-materials", () => ({ CourseAddMaterials: () => null }));
vi.mock("./course-space", () => ({ CourseSpaceHeader: () => null }));
vi.mock("./course-route-panel", () => ({ CourseRoutePanel: () => <p>原章节路线</p> }));
vi.mock("../knowledge/course-knowledge", () => ({ CourseKnowledge: () => <div id="course-knowledge">原知识目录</div> }));
vi.mock("../exam-sprint/course-exam-progress", () => ({ CourseExamProgress: () => { data.mounts(); return <p>原考试信息</p>; } }));
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => <p>原画像</p> }));
vi.mock("../learning/course-view", () => ({ CourseLearningView: () => <p>旧学习页面</p>, CourseSummaryPanel: () => <div id="course-learning-records">原学习记录</div> }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("../client/api", () => ({ createOpeningApi: () => ({}) }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  data.archived = false; data.fail = false; vi.clearAllMocks();
  window.history.replaceState(null, "", `/opening/courses/course?conversation=${conversation}&mediaSource=source&seekMs=4000&scope=course&tab=overview`);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: !data.fail, status: data.fail ? 500 : 200, json: async () => url.endsWith("/assets") ? { assets: [] } : { course: { id: courseId, title: "数学", archivedAt: data.archived ? "2026-01-01" : null } } })));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function Harness({ surface = "opening" }: { surface?: "opening" | "learn" }) {
  const [enabled, setEnabled] = useState(false);
  return <OpeningCapabilitiesContext.Provider value={{ ...CLOSED_CAPABILITIES, studySessionV2: enabled, teachingLoop: { ...CLOSED_CAPABILITIES.teachingLoop, api: true, ui: true } }}>
    <button onClick={() => setEnabled(value => !value)}>切换新版</button>
    <ObjectConversationContext.Provider value={conversation}><CourseDetail id={courseId} surface={surface} conversationId={conversation} /></ObjectConversationContext.Provider>
  </OpeningCapabilitiesContext.Provider>;
}
async function click(text: string) {
  const item = [...host.querySelectorAll<HTMLAnchorElement | HTMLButtonElement>("a,button")].find(node => node.textContent === text)!;
  await act(async () => item.click());
}
function panel(name: string) { return host.querySelector<HTMLElement>(`[data-course-tab="${name}"]`)!; }
async function visit(search: string, event = "popstate") {
  await act(async () => { window.history.replaceState(null, "", search); window.dispatchEvent(new Event(event)); });
}

it("switches the real course to three sections, keeps drafts mounted, preserves query scope and the original continue href", async () => {
  await act(async () => root.render(<Harness />));
  expect(host.querySelectorAll('nav[aria-label="课程分区"] a')).toHaveLength(6);
  await click("切换新版");
  expect([...host.querySelectorAll('nav[aria-label="课程分区"] a')].map(node => node.textContent)).toEqual(["学习安排", "章节路线", "记录与资料"]);
  expect(panel("practice").querySelector("details")?.open).toBe(false);
  const href = `/opening/courses/${courseId}/study?activity=activity-real&conversation=${conversation}`;
  expect([...host.querySelectorAll("a")].find(node => node.textContent?.startsWith("继续学习"))?.getAttribute("href")).toBe(href);
  const goal = host.querySelector<HTMLInputElement>('[aria-label="目标草稿"]')!;
  // Native input setter + React's input event exercises the controlled draft owner.
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(goal, "未保存目标"); goal.dispatchEvent(new Event("input", { bubbles: true })); });
  const calls = vi.mocked(fetch).mock.calls.length;
  await click("章节路线");
  expect(panel("units").hidden).toBe(false); expect(panel("overview").hidden).toBe(true);
  await click("记录与资料");
  const note = host.querySelector<HTMLTextAreaElement>('[aria-label="笔记草稿"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "未保存笔记"); note.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(panel("notes").hidden).toBe(false); expect(panel("materials").hidden).toBe(false);
  expect(host.textContent).toContain("还没有课程材料");
  await click("学习安排"); await click("记录与资料");
  expect(host.querySelector('[aria-label="目标草稿"]')).toBe(goal); expect(goal.value).toBe("未保存目标");
  expect(host.querySelector('[aria-label="笔记草稿"]')).toBe(note); expect(note.value).toBe("未保存笔记");
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  expect(host.querySelectorAll('[aria-label="目标草稿"]')).toHaveLength(1);
  const params = new URLSearchParams(window.location.search);
  expect(Object.fromEntries(params)).toEqual({ conversation, mediaSource: "source", seekMs: "4000", scope: "course", tab: "progress" });
  await click("切换新版");
  expect(host.querySelectorAll('nav[aria-label="课程分区"] a')).toHaveLength(6);
  expect(panel("materials").hidden).toBe(true); expect(panel("progress").hidden).toBe(false);
});

it("opens old tabs, sections and anchors at their actual target and follows back/forward history", async () => {
  await act(async () => root.render(<Harness />)); await click("切换新版");
  for (const [url, name] of [["?section=library", "materials"], ["?tab=notes", "notes"], ["?tab=practice", "practice"], ["?section=review", "review"], ["?tab=overview#course-learning-records", "progress"], ["?tab=overview#course-assets", "materials"], ["?tab=overview#course-media", "materials"], ["?tab=overview#course-knowledge", "units"], ["?tab=overview#course-units", "units"]]) {
    await visit(url!);
    expect(panel(name!).hidden).toBe(false);
    if (name === "practice" || name === "review") expect(panel(name).querySelector("details")?.open).toBe(true);
  }
  await visit("?tab=overview");
  await click("章节路线"); await click("记录与资料");
  await act(async () => { await new Promise<void>(resolve => { window.addEventListener("popstate", () => resolve(), { once: true }); window.history.back(); }); });
  expect(panel("units").hidden).toBe(false);
  await act(async () => { await new Promise<void>(resolve => { window.addEventListener("popstate", () => resolve(), { once: true }); window.history.forward(); }); });
  expect(panel("progress").hidden).toBe(false);
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  await visit("?retest=original&task=task#course-practice", "hashchange");
  expect(data.replace).toHaveBeenLastCalledWith(`/opening/courses/${courseId}/study?retest=original&task=task`);
});

it("keeps archived courses from starting study and exposes records through their old anchor", async () => {
  data.archived = true;
  await act(async () => root.render(<Harness />)); await click("切换新版");
  expect([...host.querySelectorAll("a")].some(node => node.getAttribute("href")?.includes("/study"))).toBe(false);
  expect(host.querySelector('a[href="#course-learning-records"]')).not.toBeNull();
  await visit("?tab=overview#course-learning-records", "hashchange");
  expect(panel("progress").hidden).toBe(false);
});

it("keeps material read errors truthful instead of showing an empty course", async () => {
  data.fail = true;
  await act(async () => root.render(<Harness />)); await click("切换新版");
  expect(host.textContent).toContain("课程内容加载失败");
  expect(host.textContent).not.toContain("还没有课程材料");
});

it("leaves the legacy learn surface unchanged even with the new capability enabled", async () => {
  await act(async () => root.render(<Harness surface="learn" />)); await click("切换新版");
  expect(host.textContent).toContain("旧学习页面");
  expect(host.querySelector('nav[aria-label="课程分区"]')).toBeNull();
  expect(host.querySelector('[aria-label="目标草稿"]')).toBeNull();
});
