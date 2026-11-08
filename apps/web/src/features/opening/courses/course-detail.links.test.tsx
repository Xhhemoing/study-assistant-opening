// @vitest-environment jsdom
import { act, createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { ObjectConversationContext } from "../assistant/conversation-object-context";
import { OpeningCapabilitiesContext } from "../capabilities/capabilities-provider";
import type { CourseAsset } from "./course-model";
import { CourseAssets, CourseContents, CourseDetail, CourseMediaSection } from "./course-detail";

const conversation = "11111111-1111-4111-8111-111111111111", note = "22222222-2222-4222-8222-222222222222", source = "33333333-3333-4333-8333-333333333333";
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => createElement("a", { ...props, href }, children) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement("a", props, children) }));
vi.mock("../client/api", () => ({ createOpeningApi: () => ({ listSources: async () => [{ id: "33333333-3333-4333-8333-333333333333", version: 7 }] }) }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("./use-course-study", () => ({ useCourseStudy: () => ({ activities: [], tasks: [], loading: false, reload: vi.fn() }) }));
vi.mock("./course-goal-form", () => ({ CourseGoalForm: () => null }));
vi.mock("../library/library-document-list", () => ({ LibraryDocumentList: () => null }));
vi.mock("./course-settings-panel", () => ({ CourseSettingsPanel: () => null }));
vi.mock("./course-add-materials", () => ({ CourseAddMaterials: () => null }));
vi.mock("./course-space", () => ({ CourseSpaceHeader: () => null }));
vi.mock("./course-route-panel", () => ({ CourseRoutePanel: ({ grouped }: { grouped?: boolean }) => createElement("p", { "data-route-panel": grouped ? "grouped" : "plain" }) }));
vi.mock("../knowledge/course-knowledge", () => ({ CourseKnowledge: () => null }));
vi.mock("../exam-sprint/course-exam-progress", () => ({ CourseExamProgress: () => null }));
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("../learning/course-view", () => ({ CourseLearningView: () => null, CourseSummaryPanel: () => null }));
const assets: CourseAsset[] = [
  { id: "document-asset", assetType: "document", assetId: note, role: "primary", sortOrder: 0, document: { id: note, title: "原笔记", updatedAt: "2026-10-22T08:00:00Z" } },
  { id: "source-asset", assetType: "source", assetId: source, role: "reference", sortOrder: 1, source: { id: source, name: "原材料" } },
];
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("preserves original material identity, note anchors and course filters while carrying only the original conversation", async () => {
  await act(async () => root.render(createElement(ObjectConversationContext.Provider, { value: conversation },
    createElement(CourseContents, { courseId: "course / 1", assets }),
    createElement(CourseAssets, { courseId: "course / 1", assets, onRemoved: () => undefined, libraryHref: "/opening/library?tab=notes&courseId=course%20%2F%201" }),
    createElement(CourseMediaSection, { assets, libraryMaterialsHref: "/opening/library?tab=materials&courseId=course%20%2F%201" }),
  )));
  const hrefs = [...host.querySelectorAll("a")].map(link => link.getAttribute("href"));
  expect(hrefs).toContain(`/opening/library/${note}?conversation=${conversation}`);
  const material = new URL(hrefs.find(href => href?.includes(`source=${source}`))!, "https://study.invalid");
  expect(Object.fromEntries(material.searchParams)).toEqual({ tab: "materials", source, version: "7", conversation });
  expect(hrefs).toContain(`/opening/library?tab=notes&courseId=course+%2F+1&conversation=${conversation}#document-${note}`);
  expect(hrefs.filter(href => href === `/opening/library?tab=materials&courseId=course+%2F+1&conversation=${conversation}`)).toHaveLength(1);
  expect(hrefs).toContain("#course-assets");
});

it("mounts a real source-only purpose entry without changing note actions or original material identity", async () => {
  const courseId = "55555555-5555-4555-8555-555555555555";
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ assets: [{
    id: "66666666-6666-4666-8666-666666666666", courseId, assetType: "source", assetId: source,
    purpose: "practice", updatedAt: "2026-11-08T12:00:00.123Z",
  }] }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<CourseAssets courseId={courseId} assets={assets} onRemoved={() => undefined} libraryHref="/opening/library?tab=notes" />));
  expect(host.querySelectorAll('[aria-label$="的本课程用途"]')).toHaveLength(1);
  expect(host.textContent).toContain("用途：练习材料");
  expect(host.textContent).toContain("原笔记"); expect(host.textContent).toContain("原材料");
  expect(host.querySelector(`[aria-label="将 原材料 移出此课程"]`)).not.toBeNull();
  expect(fetcher).toHaveBeenCalledWith(`/api/courses/${courseId}/assets`, expect.objectContaining({ method: "GET" }));
});

it("does not append conversation references to the legacy library URL", async () => {
  await act(async () => root.render(createElement(ObjectConversationContext.Provider, { value: conversation }, createElement(CourseAssets, { courseId: "course", assets: [assets[0]!], onRemoved: () => undefined, libraryHref: "/library?tab=notes" }))));
  expect(host.querySelector("a")?.getAttribute("href")).toBe(`/library?tab=notes#document-${note}`);
});

it.each([[false, "plain"], [true, "grouped"]] as const)("links 学习安排 to the full-course route and tells the route panel its grouped mode (studySessionV2=%s)", async (studySessionV2, mode) => {
  const courseId = "55555555-5555-4555-8555-555555555555";
  window.history.replaceState(null, "", `/opening/courses/${courseId}?tab=overview`);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.endsWith("/assets") ? { assets: [] } : { course: { id: courseId, title: "数学", archivedAt: null } } })));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  await act(async () => root.render(<OpeningCapabilitiesContext.Provider value={{ ...CLOSED_CAPABILITIES, studySessionV2, teachingLoop: { ...CLOSED_CAPABILITIES.teachingLoop, api: true, ui: true } }}>
    <CourseDetail id={courseId} surface="opening" conversationId={conversation} />
  </OpeningCapabilitiesContext.Provider>));
  const overview = host.querySelector<HTMLElement>('[data-course-tab="overview"]');
  const route = [...(overview?.querySelectorAll("a") ?? [])].find(link => link.textContent === "全课路线");
  expect(route?.getAttribute("href")).toBe(`/opening/courses/${courseId}?tab=units&conversation=${conversation}#course-learning-route`);
  expect(host.querySelector("[data-route-panel]")?.getAttribute("data-route-panel")).toBe(mode);
});
