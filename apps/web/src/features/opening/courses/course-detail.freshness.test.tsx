// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { OpeningCapabilitiesContext } from "../capabilities/capabilities-provider";
import { CourseDetail } from "./course-detail";

const courseId = "55555555-5555-4555-8555-555555555555";
const sourceId = "33333333-3333-4333-8333-333333333333";
const conversation = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  onAdded: null as null | (() => void),
  onPurposeChanged: null as null | (() => void),
  onKnowledgeRebuilt: null as null | (() => void),
  onRouteChanged: null as null | (() => void),
  removeAsset: vi.fn(async () => {}),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("../v3/motion/view-transition", () => ({
  TransitionLink: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
vi.mock("../client/api", () => ({
  createOpeningApi: () => ({ listSources: async () => [{ id: sourceId, version: 1 }] }),
}));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("./use-course-study", () => ({
  useCourseStudy: () => ({ activities: [], tasks: [], loading: false, reload: vi.fn() }),
}));
vi.mock("./course-goal-form", () => ({ CourseGoalForm: () => null }));
vi.mock("../library/library-document-list", () => ({ LibraryDocumentList: () => null }));
vi.mock("./course-settings-panel", () => ({ CourseSettingsPanel: () => null }));
vi.mock("./course-space", () => ({ CourseSpaceHeader: () => null }));
vi.mock("../exam-sprint/course-exam-progress", () => ({ CourseExamProgress: () => null }));
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("../learning/course-view", () => ({ CourseLearningView: () => null, CourseSummaryPanel: () => null }));
vi.mock("./course-state-client", () => ({
  createCourseStateClient: () => ({ removeAsset: mocks.removeAsset }),
}));
vi.mock("./course-add-materials", () => ({
  CourseAddMaterials: ({ onAdded }: { onAdded: () => void }) => {
    mocks.onAdded = onAdded;
    return <button type="button" onClick={onAdded}>触发添加材料</button>;
  },
}));
vi.mock("./course-source-purpose-control", () => ({
  CourseSourcePurposeControl: ({ onChanged }: { onChanged?: () => void }) => {
    mocks.onPurposeChanged = onChanged ?? null;
    return <button type="button" onClick={() => onChanged?.()}>触发用途更新</button>;
  },
}));
vi.mock("./course-route-panel", () => ({
  CourseRoutePanel: ({
    refreshToken,
    onKnowledgeRebuilt,
    onChanged,
  }: {
    refreshToken?: number;
    onKnowledgeRebuilt?: () => void;
    onChanged?: () => void;
  }) => {
    mocks.onKnowledgeRebuilt = onKnowledgeRebuilt ?? null;
    mocks.onRouteChanged = onChanged ?? null;
    return <div data-route-refresh={String(refreshToken ?? 0)} />;
  },
}));
vi.mock("../knowledge/course-knowledge", () => ({
  CourseKnowledge: ({ knowledgeRefreshToken }: { knowledgeRefreshToken?: number }) => (
    <div data-knowledge-refresh={String(knowledgeRefreshToken ?? 0)} />
  ),
}));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.onAdded = null;
  mocks.onPurposeChanged = null;
  mocks.onKnowledgeRebuilt = null;
  mocks.onRouteChanged = null;
  window.history.replaceState(null, "", `/opening/courses/${courseId}?tab=materials`);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function renderDetail() {
  return act(async () => {
    root.render(
      <OpeningCapabilitiesContext.Provider value={{ ...CLOSED_CAPABILITIES, studySessionV2: true, teachingLoop: { ...CLOSED_CAPABILITIES.teachingLoop, api: true, ui: true } }}>
        <CourseDetail id={courseId} surface="opening" conversationId={conversation} />
      </OpeningCapabilitiesContext.Provider>,
    );
  });
}

const queuedAsset = {
  id: "asset-1",
  assetType: "source",
  assetId: sourceId,
  role: "core",
  sortOrder: 0,
  source: { id: sourceId, name: "讲义.pdf", uploadState: "uploaded", parseState: "queued" },
};
const readyAsset = {
  ...queuedAsset,
  source: { ...queuedAsset.source, parseState: "ready" },
};

it("wires cross-tab knowledgeRefreshToken and routeRefreshToken across rebuild, route changes, add, purpose update, and removal", async () => {
  let assetCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/assets")) {
      assetCalls += 1;
      return Response.json({ assets: [readyAsset] });
    }
    return Response.json({ course: { id: courseId, title: "高数", slug: "calc", description: "", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", archivedAt: null, learningPreferenceOverrides: {} } });
  }));

  await renderDetail();
  const knowledge = () => Number(host.querySelector("[data-knowledge-refresh]")?.getAttribute("data-knowledge-refresh"));
  const route = () => Number(host.querySelector("[data-route-refresh]")?.getAttribute("data-route-refresh"));
  expect(knowledge()).toBe(0);
  expect(route()).toBe(0);

  await act(async () => mocks.onKnowledgeRebuilt?.());
  expect(knowledge()).toBe(1);

  await act(async () => mocks.onRouteChanged?.());
  expect(knowledge()).toBe(2);

  await act(async () => mocks.onPurposeChanged?.());
  expect(knowledge()).toBe(3);
  expect(route()).toBe(1);
  expect(assetCalls).toBe(2);

  await act(async () => mocks.onAdded?.());
  expect(knowledge()).toBe(4);
  expect(route()).toBe(2);
  expect(assetCalls).toBe(3);

  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="将 讲义.pdf 移出此课程"]')!.click());
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "确认移出此课程")!.click());
  expect(mocks.removeAsset).toHaveBeenCalledTimes(1);
  expect(knowledge()).toBe(5);
  expect(route()).toBe(3);
});

it("polls queued/parsing sources via startSourceRefresh until ready and triggers cross-tab refresh", async () => {
  vi.useFakeTimers();
  let assetCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/assets")) {
      assetCalls += 1;
      const current = assetCalls === 1 ? queuedAsset : assetCalls === 2 ? { ...queuedAsset, source: { ...queuedAsset.source, parseState: "parsing" } } : readyAsset;
      return Response.json({ assets: [current] });
    }
    return Response.json({ course: { id: courseId, title: "高数", slug: "calc", description: "", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", archivedAt: null, learningPreferenceOverrides: {} } });
  }));

  await renderDetail();
  expect(host.textContent).toContain("原件已保存，解析排队中");
  expect(host.querySelector("[data-knowledge-refresh]")?.getAttribute("data-knowledge-refresh")).toBe("0");

  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(assetCalls).toBe(2);
  expect(host.textContent).toContain("原件已保存，正在解析");
  expect(host.querySelector("[data-knowledge-refresh]")?.getAttribute("data-knowledge-refresh")).toBe("0");

  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(assetCalls).toBe(3);
  expect(host.textContent).toContain("可以用于提问");
  expect(host.querySelector("[data-knowledge-refresh]")?.getAttribute("data-knowledge-refresh")).toBe("1");
  expect(host.querySelector("[data-route-refresh]")?.getAttribute("data-route-refresh")).toBe("1");

  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(assetCalls).toBe(3);
});
