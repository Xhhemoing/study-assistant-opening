// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssetGraphEdge,
  AssetGraphPage,
  CourseRouteActionResult,
  CourseRouteSnapshot,
  CourseRouteTaskContext,
  TeachingActivity,
} from "@aistudy/contracts";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { notifyOpeningPrivacyChange } from "../client/privacy-change";
import type { CourseRouteClient } from "../courses/course-route-client";
import {
  bundleCanvasEdges,
  computeHighlightedLineage,
} from "./asset-graph-canvas";
import {
  AssetGraphRequestError,
  createSyntheticAssetGraphTransport,
  type AssetGraphTransport,
  type SyntheticAssetGraphFixtures,
} from "./asset-graph-client";
import { AssetGraphWorkspace } from "./asset-graph-workspace";

const fixturesPath = resolve(
  __dirname,
  "../../../../../../docs/brainstorm/2026-11-18-knowledge-assets-examples.json",
);
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as SyntheticAssetGraphFixtures;

function fixtureCase(name: string) {
  const found = fixtures.cases.find(item => item.name === name);
  if (!found) {
    throw new Error(`Missing fixture case: ${name}`);
  }
  return found;
}

function fixturePage(name: string): AssetGraphPage {
  return fixtureCase(name).response as AssetGraphPage;
}

function fixtureNodeLabel(nodeId: string): string {
  for (const entry of fixtures.cases) {
    if (entry.http === 200) {
      const page = entry.response as AssetGraphPage;
      const node = page.nodes.find(item => item.id === nodeId);
      if (node?.label) {
        return node.label;
      }
    }
  }
  throw new Error(`Missing fixture node label for ${nodeId}`);
}

const COURSE_ID = "10000000-0000-4000-8000-000000000001";
const GOAL_ID = "goal/20000000-0000-4000-8000-000000000001" as const;
const REQ_ID = "requirement/30000000-0000-4000-8000-000000000001" as const;
const SOURCE_1_ID = "source/40000000-0000-4000-8000-000000000001" as const;
const SOURCE_2_ID = "source/40000000-0000-4000-8000-000000000002" as const;
const OBS_ID = "observation/50000000-0000-4000-8000-000000000001" as const;
const DOC_ID = "document/60000000-0000-4000-8000-000000000001" as const;
const EXP_ID = "exploration/70000000-0000-4000-8000-000000000001" as const;
const MISSING_DOC_ID = "document/80000000-0000-4000-8000-000000000001" as const;
const ACTIVITY_ID = "90000000-0000-4000-8000-000000000001";

const GOAL_LABEL = fixtureNodeLabel(GOAL_ID);
const REQ_LABEL = fixtureNodeLabel(REQ_ID);
const SOURCE_1_LABEL = fixtureNodeLabel(SOURCE_1_ID);
const SOURCE_2_LABEL = fixtureNodeLabel(SOURCE_2_ID);
const OBS_1_LABEL = fixtureNodeLabel(OBS_ID);
const DOC_LABEL = fixtureNodeLabel(DOC_ID);
const EXP_LABEL = fixtureNodeLabel(EXP_ID);
const UNSCOPED_DOC_QUERY = String(
  (fixtureCase("synthetic-unscoped-01-workspace-document-roots").request.body as { q?: string }).q,
);
const EXPLORATION_NOTE_0 =
  fixturePage("synthetic-unscoped-03-same-exploration-detail-without-invented-ui").detail
    ?.notes[0] ?? "";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderWorkspace(props: Parameters<typeof AssetGraphWorkspace>[0]) {
  await act(async () => {
    root.render(createElement(AssetGraphWorkspace, props));
  });
  await flush();
}

function findButton(text: string, within: ParentNode = container): HTMLButtonElement {
  const button = Array.from(within.querySelectorAll("button")).find(item =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing button containing "${text}"`);
  return button;
}

function nodeCard(nodeId: string): HTMLLIElement {
  const card = container.querySelector<HTMLLIElement>(`[data-node-card="${nodeId}"]`);
  if (!card) throw new Error(`Missing node card ${nodeId}`);
  return card;
}

function makeReadyResult(): Extract<CourseRouteActionResult, { kind: "ready" }> {
  const activity: TeachingActivity = {
    id: ACTIVITY_ID,
    workspaceId: "00000000-0000-4000-8000-000000000010",
    ownerUserId: "00000000-0000-4000-8000-000000000020",
    courseId: COURSE_ID,
    status: "active",
    generateStatus: "ready",
    intentKind: "topic",
    intentSummary: "专项练习",
    sourceIds: [],
    pathVersion: 1,
    contentVersion: 1,
    clientKey: "test-activity",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    kind: "ready",
    activity,
    href: `/opening/courses/${COURSE_ID}/study?activity=${ACTIVITY_ID}`,
    resumed: false,
    requirementId: "30000000-0000-4000-8000-000000000001",
    action: "targeted_explain",
  };
}

describe("Canvas pure helpers (Slice B)", () => {
  it("deduplicates multi-page edges by (from, to, relation, basis, sourceVersion, linkId) while keeping distinct basis or linkId separate", () => {
    const edges: AssetGraphEdge[] = [
      {
        id: "e-p18",
        from: REQ_ID,
        to: SOURCE_1_ID,
        relation: "usesSource",
        basis: "recorded",
        sourceVersion: 1,
        page: 18,
      },
      {
        id: "e-p5",
        from: REQ_ID,
        to: SOURCE_1_ID,
        relation: "usesSource",
        basis: "recorded",
        sourceVersion: 1,
        page: 5,
      },
      {
        id: "e-suggested",
        from: REQ_ID,
        to: SOURCE_1_ID,
        relation: "usesSource",
        basis: "suggested",
        sourceVersion: 1,
        page: 9,
      },
      {
        id: "e-shared-1",
        from: REQ_ID,
        to: OBS_ID,
        relation: "hasObservation",
        basis: "derived",
        sharedAttribution: {
          linkId: "a0000000-0000-4000-8000-000000000011",
          linkRevision: 1,
          stableSkillId: "b0000000-0000-4000-8000-000000000011",
          sourceCourseId: COURSE_ID,
          sourceCourseTitle: "基础化学",
          sourceRequirementId: "30000000-0000-4000-8000-000000000001",
          sourceRequirementTitle: "化学键基础",
          sourceRequirementRevision: 1,
          targetRequirementRevision: 1,
          effective: true,
        },
      },
      {
        id: "e-shared-2",
        from: REQ_ID,
        to: OBS_ID,
        relation: "hasObservation",
        basis: "derived",
        sharedAttribution: {
          linkId: "a0000000-0000-4000-8000-000000000022",
          linkRevision: 1,
          stableSkillId: "b0000000-0000-4000-8000-000000000022",
          sourceCourseId: COURSE_ID,
          sourceCourseTitle: "基础化学",
          sourceRequirementId: "30000000-0000-4000-8000-000000000001",
          sourceRequirementTitle: "酸碱平衡",
          sourceRequirementRevision: 1,
          targetRequirementRevision: 1,
          effective: true,
        },
      },
    ];

    const bundled = bundleCanvasEdges(edges);
    expect(bundled).toHaveLength(4);
    expect(bundled[0]?.pages).toEqual([5, 18]);
    expect(bundled[0]?.edges).toHaveLength(2);
    expect(bundled[1]?.primary.basis).toBe("suggested");
  });

  it("highlights 1-hop direct neighbors plus up to 3 upstream foundation hops and stops before hop 4", () => {
    const k0 = "knowledge/41000000-0000-4000-8000-000000000000" as const;
    const k1 = "knowledge/41000000-0000-4000-8000-000000000001" as const;
    const k2 = "knowledge/41000000-0000-4000-8000-000000000002" as const;
    const k3 = "knowledge/41000000-0000-4000-8000-000000000003" as const;
    const k4 = "knowledge/41000000-0000-4000-8000-000000000004" as const;

    const edges: AssetGraphEdge[] = [
      { id: "map", from: REQ_ID, to: k0, relation: "mappedTo", basis: "recorded" },
      { id: "hop1", from: k1, to: k0, relation: "prerequisite", basis: "recorded" },
      { id: "hop2", from: k2, to: k1, relation: "prerequisite", basis: "derived" },
      { id: "hop3", from: k3, to: k2, relation: "contains", basis: "recorded" },
      { id: "hop4", from: k4, to: k3, relation: "prerequisite", basis: "suggested" },
    ];

    const lineage = computeHighlightedLineage(REQ_ID, edges);
    expect([...lineage.nodeSet]).toEqual(expect.arrayContaining([REQ_ID, k0, k1, k2, k3]));
    expect(lineage.nodeSet.has(k4)).toBe(false);
    expect(lineage.edgeSet.has("hop3")).toBe(true);
    expect(lineage.edgeSet.has("hop4")).toBe(false);
  });
});

describe("AssetGraphWorkspace", () => {
  it("shows upcoming API notice with safe navigation links when neither transport nor endpoint is provided", async () => {
    await renderWorkspace({});
    expect(container.textContent).toContain("知识地图接口即将接入，当前可先使用课程与资料列表");
    const hrefs = Array.from(container.querySelectorAll("a")).map(a => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/opening/courses", "/opening/library"]));
  });

  it("replays Path 1 (goal -> requirement -> sources/observations -> detail) and starts course requirement on ready", async () => {
    const startMock = vi.fn<CourseRouteClient["start"]>(async () => makeReadyResult());
    const onNavigate = vi.fn();

    await renderWorkspace({
      transport: createSyntheticAssetGraphTransport(fixtures),
      courseRouteClient: { start: startMock },
      onNavigate,
    });

    // Initial workspace roots (Case 1)
    expect(container.textContent).toContain(GOAL_LABEL);
    expect(container.textContent).toContain(DOC_LABEL);

    // Enter goal scope (Case 3)
    await act(async () => {
      findButton("进入目标范围", nodeCard(GOAL_ID)).click();
    });
    await flush();
    expect(container.textContent).toContain(REQ_LABEL);

    // Expand requirement outgoing neighbors (Case 4)
    await act(async () => {
      findButton("出边展开", nodeCard(REQ_ID)).click();
    });
    await flush();
    expect(container.textContent).toContain(SOURCE_1_LABEL);
    expect(container.textContent).toContain(OBS_1_LABEL);

    // Toggle summary display ON (Case 4b)
    const summaryCheckbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      summaryCheckbox.click();
    });
    await flush();
    expect(nodeCard(REQ_ID).textContent).toContain("提示后完成");
    expect(nodeCard(REQ_ID).textContent).toContain("曾受助");

    // View detail (Case 8)
    await act(async () => {
      findButton("查看详情", nodeCard(REQ_ID)).click();
    });
    await flush();
    expect(container.textContent).toContain("本例只表示已记录的提示后完成证据，不推导掌握率。");

    // Click start action -> calls start with minutes=20 and navigates on ready
    await act(async () => {
      findButton("继续学习这项要求").click();
    });
    await flush();

    expect(startMock).toHaveBeenCalledTimes(1);
    const [calledCourseId, payload] = startMock.mock.calls[0]!;
    expect(calledCourseId).toBe(COURSE_ID);
    expect(payload).toMatchObject({
      goalId: "20000000-0000-4000-8000-000000000001",
      requirementId: "30000000-0000-4000-8000-000000000001",
      expectedGoalRevision: 3,
      expectedRequirementRevision: 2,
      minutes: 20,
    });
    expect(payload.clientKey.length).toBeGreaterThanOrEqual(8);
    expect(onNavigate).toHaveBeenCalledWith(
      `/opening/courses/${COURSE_ID}/study?activity=${ACTIVITY_ID}`,
    );
  });

  it("replays Path 2 (unscoped workspace document -> incoming promotedTo -> exploration detail)", async () => {
    await renderWorkspace({
      transport: createSyntheticAssetGraphTransport(fixtures),
      initialLens: "assets",
    });

    // Select document kind and search title (Case 9)
    const kindSelect = container.querySelector<HTMLSelectElement>('select[aria-label="起点类型"]')!;
    const searchInput = container.querySelector<HTMLInputElement>('input[aria-label="标题检索"]')!;
    const searchForm = container.querySelector<HTMLFormElement>('form[role="search"]')!;

    await act(async () => {
      const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setSelect.call(kindSelect, "document");
      kindSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    await act(async () => {
      const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setInput.call(searchInput, UNSCOPED_DOC_QUERY);
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(nodeCard(DOC_ID).textContent).toContain(DOC_LABEL);

    // Incoming expansion (Case 10)
    await act(async () => {
      findButton("入边探索", nodeCard(DOC_ID)).click();
    });
    await flush();
    expect(nodeCard(EXP_ID).textContent).toContain(EXP_LABEL);

    // Exploration detail (Case 11)
    await act(async () => {
      findButton("查看详情", nodeCard(EXP_ID)).click();
    });
    await flush();
    expect(container.textContent).toContain(EXPLORATION_NOTE_0);
    expect(container.textContent).toContain("这项内容下暂时没有可直接打开的后续入口。");
  });

  it("replays Path 3 (keeps requirement focus across all -> assets -> evidence lens switches)", async () => {
    await renderWorkspace({
      transport: createSyntheticAssetGraphTransport(fixtures),
      initialContext: { kind: "goal", id: GOAL_ID },
      initialLens: "all",
    });

    await act(async () => {
      findButton("出边展开", nodeCard(REQ_ID)).click();
    });
    await flush();
    expect(container.textContent).toContain(SOURCE_1_LABEL);
    expect(container.textContent).toContain(OBS_1_LABEL);

    // Switch to assets lens (Case 5) -> requirement stays focused, shows source only
    await act(async () => {
      findButton("材料与笔记").click();
    });
    await flush();
    expect(nodeCard(REQ_ID).querySelector("button[aria-pressed='true']")).not.toBeNull();
    expect(container.textContent).toContain(SOURCE_1_LABEL);
    expect(container.textContent).not.toContain(OBS_1_LABEL);

    // Switch to evidence lens: requirement stays focused, shows observation only
    await act(async () => {
      findButton("练习记录").click();
    });
    await flush();
    expect(nodeCard(REQ_ID).querySelector("button[aria-pressed='true']")).not.toBeNull();
    expect(nodeCard(OBS_ID).textContent).toContain(OBS_1_LABEL);
    expect(container.textContent).not.toContain(SOURCE_1_LABEL);
  });

  it("supports roots pagination and recovers from 409 CURSOR_STALE", async () => {
    const baseTransport = createSyntheticAssetGraphTransport(fixtures);
    let injectStaleOnce = false;
    const transport: AssetGraphTransport = async (query, signal) => {
      if (
        query.op === "roots" &&
        query.cursor === "synthetic-source-roots-page-2-v1" &&
        injectStaleOnce
      ) {
        injectStaleOnce = false;
        return baseTransport({ ...query, cursor: "synthetic-expired-source-roots-v0" }, signal);
      }
      return baseTransport(query, signal);
    };

    await renderWorkspace({
      transport,
      initialLens: "assets",
      initialPageLimit: 1,
    });

    // Trigger source roots page 1 (Case 12)
    const kindSelect = container.querySelector<HTMLSelectElement>('select[aria-label="起点类型"]')!;
    await act(async () => {
      const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setSelect.call(kindSelect, "source");
      kindSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(nodeCard(SOURCE_1_ID)).toBeTruthy();
    expect(findButton("加载下一页")).toBeTruthy();

    // First next-page attempt triggers 409 CURSOR_STALE -> restarts cleanly from page 1
    injectStaleOnce = true;
    await act(async () => {
      findButton("加载下一页").click();
    });
    await flush();
    expect(container.textContent).toContain("已从第 1 页重新读取");
    expect(nodeCard(SOURCE_1_ID)).toBeTruthy();

    // Second next-page attempt succeeds (Case 13)
    await act(async () => {
      findButton("加载下一页").click();
    });
    await flush();
    expect(nodeCard(SOURCE_2_ID).textContent).toContain(SOURCE_2_LABEL);
  });

  it("displays partial completeness warning with retry and handles 404 NOT_FOUND safely", async () => {
    await renderWorkspace({
      transport: createSyntheticAssetGraphTransport(fixtures),
      initialContext: { kind: "goal", id: GOAL_ID },
      initialLens: "structure",
    });

    // Case 15 partial warning
    expect(container.querySelector('[aria-label="内容缺口提示"]')?.textContent).toContain(
      "部分适用范围暂未能核对，仅显示已确认的要求关系。",
    );
    await act(async () => {
      findButton("重试读取").click();
    });
    await flush();
    expect(container.textContent).toContain(REQ_LABEL);

    // Case 16 404 NOT_FOUND on initialFocus
    await renderWorkspace({
      transport: createSyntheticAssetGraphTransport(fixtures),
      initialFocus: MISSING_DOC_ID,
    });
    expect(container.textContent).toContain("所选内容不可用或不在当前范围");
  });

  it("invalidates cached graph and reloads on privacy change notification", async () => {
    const baseTransport = createSyntheticAssetGraphTransport(fixtures);
    const spyTransport = vi.fn<AssetGraphTransport>(baseTransport);

    await renderWorkspace({ transport: spyTransport });
    expect(spyTransport).toHaveBeenCalledTimes(1);

    await act(async () => {
      notifyOpeningPrivacyChange();
    });
    await flush();

    expect(spyTransport).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("可见范围设置已变更，已清空旧视图并重新读取");
  });

  it("handles startCourseRequirement choice branch without optimistic verified state and reuses clientKey on retry", async () => {
    const choiceResult: Extract<CourseRouteActionResult, { kind: "choice" }> = {
      kind: "choice",
      reason: "scope_unconfirmed",
      message: "请先确认本课学习范围后再开始练习。",
      courseId: COURSE_ID,
      href: `/opening/courses/${COURSE_ID}#course-learning-route`,
      requirementIds: ["30000000-0000-4000-8000-000000000001"],
    };
    const startMock = vi
      .fn<CourseRouteClient["start"]>()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(choiceResult);

    await renderWorkspace({
      transport: createSyntheticAssetGraphTransport(fixtures),
      courseRouteClient: { start: startMock },
      initialContext: { kind: "goal", id: GOAL_ID },
      initialLens: "all",
      initialFocus: REQ_ID,
    });

    // First click fails with network error -> preserves clientKey & renders retry button
    await act(async () => {
      findButton("继续学习这项要求").click();
    });
    await flush();

    expect(startMock).toHaveBeenCalledTimes(1);
    const firstPayload = startMock.mock.calls[0]![1];
    expect(container.textContent).toContain("本次安排结果未确认");

    // Retry reuses the EXACT same clientKey and minutes, receives choice result
    await act(async () => {
      findButton("重试本次安排").click();
    });
    await flush();

    expect(startMock).toHaveBeenCalledTimes(2);
    const secondPayload = startMock.mock.calls[1]![1];
    expect(secondPayload.clientKey).toBe(firstPayload.clientKey);
    expect(secondPayload.minutes).toBe(firstPayload.minutes);

    expect(container.textContent).toContain("请先确认本课学习范围后再开始练习。");
    expect(
      container.querySelector(`a[href="/opening/courses/${COURSE_ID}#course-learning-route"]`),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("已达到课程要求");
  });

  it("renders cross-course sharedAttribution badge, caption, and source course link in expanded edges (Case 21)", async () => {
    const COURSE_2 = "10000000-0000-4000-8000-000000000002";
    const REQ_2 = "requirement/30000000-0000-4000-8000-000000000002" as const;
    const OBS_2 = "observation/50000000-0000-4000-8000-000000000002" as const;
    const sharedPage = fixturePage("synthetic-shared-skills-01-cross-course-evidence-neighbors");
    const req2Label = fixtureNodeLabel(REQ_2);
    const sharedAttr = sharedPage.edges[0]!.sharedAttribution!;
    const expectedSharedCaption = `跨课共享自「${sharedAttr.sourceCourseTitle} · ${sharedAttr.sourceRequirementTitle}」（第 ${sharedAttr.sourceRequirementRevision} 版）`;

    const baseTransport = createSyntheticAssetGraphTransport(fixtures);
    const transport: AssetGraphTransport = async (query, signal) => {
      if (
        query.op === "roots" &&
        query.context.kind === "course" &&
        query.context.id === `course/${COURSE_2}`
      ) {
        return {
          asOf: "2026-01-01T00:00:00.000Z",
          nodes: [
            {
              id: REQ_2,
              kind: "requirement",
              label: req2Label,
              ...(query.include?.includes("summary")
                ? { summary: { learnerState: "independent", requirementStatus: "verified" } }
                : {}),
            },
          ],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      return baseTransport(query, signal);
    };

    await renderWorkspace({
      transport,
      initialContext: { kind: "course", id: `course/${COURSE_2}` },
      initialLens: "evidence",
      courses: [
        { id: COURSE_ID, title: sharedAttr.sourceCourseTitle },
        { id: COURSE_2, title: "高阶迁移课程" },
      ],
    });

    // Focus REQ_2 first, then toggle summary ON -> triggers Case 21 directly from fixtures
    await act(async () => {
      nodeCard(REQ_2).querySelector("button")!.click();
    });
    await flush();

    const summaryCheckbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      summaryCheckbox.click();
    });
    await flush();

    expect(sharedAttr.sourceRequirementRevision).toBe(2);
    expect(nodeCard(REQ_2).textContent).toContain("独立完成");
    expect(nodeCard(REQ_2).textContent).toContain("已达到课程要求");
    expect(nodeCard(OBS_2).textContent).toContain("独立作答记录");
    expect(container.textContent).toContain("当前已展开关联");
    expect(container.textContent).toContain("跨课共享证据");
    expect(container.textContent).toContain(expectedSharedCaption);
    const sourceLink = Array.from(container.querySelectorAll("a")).find(a =>
      a.textContent?.includes("查看来源课程"),
    );
    expect(sourceLink?.getAttribute("href")).toBe(`/opening/courses/${COURSE_ID}`);

    // Focusing the observation shows the incoming shared attribution edge too
    await act(async () => {
      nodeCard(OBS_2).querySelector("button")!.click();
    });
    await flush();
    expect(container.textContent).toContain(expectedSharedCaption);
    expect(container.querySelector(`a[href="/opening/courses/${COURSE_ID}"]`)).not.toBeNull();
  });

  it("supports switching between graph and list views, basis-distinct SVG edges, collapse, and pinned comparison", async () => {
    const k1 = "knowledge/41000000-0000-4000-8000-000000000001" as const;
    const transport: AssetGraphTransport = async query => {
      if (query.op === "neighbors") {
        return {
          asOf: "2026-03-01T00:00:00.000Z",
          nodes: [
            { id: REQ_ID, kind: "requirement", label: "酯化平衡条件" },
            { id: SOURCE_1_ID, kind: "source", label: "实验手册", meta: { version: 2 } },
            {
              id: OBS_ID,
              kind: "observation",
              label: "课堂练习提交",
              meta: { occurredAt: "2026-02-20T09:30:00.000Z", assistance: "independent" },
            },
            { id: k1, kind: "knowledge", label: "可逆反应平衡常数" },
          ],
          edges: [
            {
              id: "edge-rec",
              from: REQ_ID,
              to: SOURCE_1_ID,
              relation: "usesSource",
              basis: "recorded",
              sourceVersion: 2,
              page: 12,
            },
            {
              id: "edge-der",
              from: REQ_ID,
              to: OBS_ID,
              relation: "hasObservation",
              basis: "derived",
            },
            {
              id: "edge-sug",
              from: REQ_ID,
              to: k1,
              relation: "mappedTo",
              basis: "suggested",
            },
          ],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      return {
        asOf: "2026-03-01T00:00:00.000Z",
        nodes: [{ id: REQ_ID, kind: "requirement", label: "酯化平衡条件" }],
        edges: [],
        page: { nextCursor: null },
        completeness: "complete",
        warnings: [],
        detail: null,
      };
    };

    await renderWorkspace({ transport });
    await act(async () => {
      findButton("出边展开", nodeCard(REQ_ID)).click();
    });
    await flush();

    // Verify basis-distinct SVG edges in Canvas
    expect(container.querySelector('[data-edge-basis="recorded"]')).not.toBeNull();
    expect(
      container
        .querySelector('[data-edge-basis="derived"] path')
        ?.getAttribute("stroke-dasharray"),
    ).toBe("8 4");
    expect(
      container
        .querySelector('[data-edge-basis="suggested"] path')
        ?.getAttribute("stroke-dasharray"),
    ).toBe("3 4");

    // Pin REQ_ID for comparison and focus SOURCE_1_ID
    await act(async () => {
      findButton("固定对比", nodeCard(REQ_ID)).click();
    });
    await flush();
    await act(async () => {
      nodeCard(SOURCE_1_ID).querySelector("button")!.click();
    });
    await flush();
    expect(container.querySelector('section[aria-label="对比参考卡片"]')?.textContent).toContain(
      "酯化平衡条件",
    );

    // Switch to List View and verify Relations / Nodes / Timeline tabs without extra network calls
    const viewToolbar = container.querySelector('[aria-label="视图模式"]')!;
    await act(async () => {
      findButton("列表", viewToolbar).click();
    });
    await flush();

    expect(container.querySelector("[data-list-view]")).not.toBeNull();
    expect(container.querySelector('table[aria-label="已展开关联列表"]')?.textContent).toContain(
      "第 12 页",
    );

    const timelineRadio = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="asset-graph-list-tab"]'),
    ).find(input => input.parentElement?.textContent?.includes("练习时间线"))!;
    await act(async () => {
      timelineRadio.click();
    });
    await flush();
    expect(container.textContent).toContain("课堂练习提交");

    const nodesRadio = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="asset-graph-list-tab"]'),
    ).find(input => input.parentElement?.textContent?.includes("当前展示的项目"))!;
    await act(async () => {
      nodesRadio.click();
    });
    await flush();

    // Collapse REQ_ID from List View -> evicts unanchored leaf nodes
    await act(async () => {
      findButton("收起关联", nodeCard(REQ_ID)).click();
    });
    await flush();
    expect(container.querySelector(`[data-node-card="${OBS_ID}"]`)).toBeNull();
  });

  it("Counterexample 1: renders real chapter titles ('第3章 有机反应：酯化') in both Graph and List views without any calculus sample text", async () => {
    const chemGoalId = "goal/21000000-0000-4000-8000-000000000001" as const;
    const chemReqId = "requirement/31000000-0000-4000-8000-000000000003" as const;
    const chemSourceId = "source/41000000-0000-4000-8000-000000000003" as const;

    const transport: AssetGraphTransport = async () => ({
      asOf: "2026-03-10T00:00:00.000Z",
      nodes: [
        { id: chemGoalId, kind: "goal", label: "掌握羧酸衍生物制备与鉴定" },
        { id: chemReqId, kind: "requirement", label: "第3章 有机反应：酯化" },
        { id: chemSourceId, kind: "source", label: "有机化学实验讲义（第3章）" },
      ],
      edges: [
        {
          id: "chem-scope",
          from: chemGoalId,
          to: chemReqId,
          relation: "scopes",
          basis: "recorded",
        },
        {
          id: "chem-source",
          from: chemReqId,
          to: chemSourceId,
          relation: "usesSource",
          basis: "recorded",
          page: 42,
        },
      ],
      page: { nextCursor: null },
      completeness: "complete",
      warnings: [],
      detail: null,
    });

    await renderWorkspace({ transport });

    // Graph view check
    expect(container.textContent).toContain("第3章 有机反应：酯化");
    expect(container.textContent).not.toContain("微分与 Taylor");
    expect(container.textContent).not.toContain("积分与微分方程");
    expect(container.textContent).not.toContain("变化率");

    // List view check (Relations & Nodes sub-tabs)
    const viewToolbar = container.querySelector('[aria-label="视图模式"]')!;
    await act(async () => {
      findButton("列表", viewToolbar).click();
    });
    await flush();

    expect(container.textContent).toContain("第3章 有机反应：酯化");
    expect(container.textContent).not.toContain("微分与 Taylor");
    expect(container.textContent).not.toContain("积分与微分方程");

    const nodesRadio = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="asset-graph-list-tab"]'),
    ).find(input => input.parentElement?.textContent?.includes("当前展示的项目"))!;
    await act(async () => {
      nodesRadio.click();
    });
    await flush();

    expect(nodeCard(chemReqId).textContent).toContain("第3章 有机反应：酯化");
    expect(container.textContent).not.toContain("微分与 Taylor");
  });

  it("Counterexample 2: Case 21 REQ_2 shows cross-course badge & source link in both Canvas and List views, and needs_verification never claims independent completion for target course", async () => {
    const COURSE_2 = "10000000-0000-4000-8000-000000000002";
    const REQ_2 = "requirement/30000000-0000-4000-8000-000000000002" as const;
    const OBS_2 = "observation/50000000-0000-4000-8000-000000000002" as const;
    const sharedPage = fixturePage("synthetic-shared-skills-01-cross-course-evidence-neighbors");
    const req2Label = fixtureNodeLabel(REQ_2);
    const sharedEdge = sharedPage.edges[0]!;
    const sharedAttr = sharedEdge.sharedAttribution!;
    const expectedSharedCaption = `跨课共享自「${sharedAttr.sourceCourseTitle} · ${sharedAttr.sourceRequirementTitle}」（第 ${sharedAttr.sourceRequirementRevision} 版）`;

    const transport: AssetGraphTransport = async query => {
      if (query.op === "neighbors" && query.focus === REQ_2) {
        return {
          ...sharedPage,
          nodes: sharedPage.nodes.map(node =>
            node.id === REQ_2
              ? {
                  ...node,
                  summary: {
                    learnerState: null,
                    requirementStatus: "needs_verification",
                  },
                }
              : node,
          ),
        };
      }
      return {
        asOf: "2026-01-01T00:00:00.000Z",
        nodes: [
          {
            id: REQ_2,
            kind: "requirement",
            label: req2Label,
            summary: {
              learnerState: null,
              requirementStatus: "needs_verification",
            },
          },
        ],
        edges: [],
        page: { nextCursor: null },
        completeness: "complete",
        warnings: [],
        detail: null,
      };
    };

    await renderWorkspace({
      transport,
      initialContext: { kind: "course", id: `course/${COURSE_2}` },
      initialLens: "evidence",
      courses: [
        { id: COURSE_ID, title: sharedAttr.sourceCourseTitle },
        { id: COURSE_2, title: "有机合成进阶" },
      ],
    });

    await act(async () => {
      findButton("出边展开", nodeCard(REQ_2)).click();
    });
    await flush();

    // 1) Graph (Canvas) view scoped assertions: SVG canvas, target requirement card, shared observation card, and detail panel
    const canvasSvg = container.querySelector('svg[aria-label^="学习地图："]')!;
    const reqSvgNode = canvasSvg.querySelector(`[data-graph-node="${REQ_2}"]`)!;
    expect(reqSvgNode.textContent).toContain("待独立检验");
    expect(reqSvgNode.textContent).not.toContain("独立完成");
    expect(reqSvgNode.textContent).not.toContain("已达到课程要求");
    expect(canvasSvg.textContent).toContain("跨课共享证据");
    expect(canvasSvg.textContent).toContain(expectedSharedCaption);

    const canvasReqCard = nodeCard(REQ_2);
    expect(canvasReqCard.textContent).toContain("课程要求：待独立检验");
    expect(canvasReqCard.textContent).not.toContain("独立完成");
    expect(canvasReqCard.textContent).not.toContain("已达到课程要求");
    expect(canvasReqCard.textContent).toContain("跨课共享证据");
    expect(canvasReqCard.textContent).toContain(expectedSharedCaption);
    expect(canvasReqCard.querySelector(`a[href="/opening/courses/${COURSE_ID}"]`)).not.toBeNull();

    const canvasObsCard = nodeCard(OBS_2);
    expect(canvasObsCard.textContent).toContain("完成条件：独立完成");
    expect(canvasObsCard.textContent).toContain("跨课共享证据");
    expect(canvasObsCard.textContent).toContain(expectedSharedCaption);

    const detailAside = container.querySelector('aside[aria-label="详情与后续行动面板"]')!;
    expect(detailAside.textContent).toContain("待独立检验");
    expect(detailAside.textContent).toContain("暂无练习状态");
    expect(detailAside.textContent).not.toContain("独立完成");
    expect(detailAside.textContent).not.toContain("已达到课程要求");
    expect(detailAside.textContent).toContain("跨课共享证据");
    expect(detailAside.textContent).toContain(expectedSharedCaption);
    expect(detailAside.querySelector(`a[href="/opening/courses/${COURSE_ID}"]`)).not.toBeNull();

    // 2) List view scoped assertions (both Relations table and Nodes list)
    const viewToolbar = container.querySelector('[aria-label="视图模式"]')!;
    await act(async () => {
      findButton("列表", viewToolbar).click();
    });
    await flush();

    const relationsTable = container.querySelector('table[aria-label="已展开关联列表"]')!;
    expect(relationsTable.textContent).toContain("跨课共享证据");
    expect(relationsTable.textContent).toContain(expectedSharedCaption);
    expect(relationsTable.querySelector(`a[href="/opening/courses/${COURSE_ID}"]`)).not.toBeNull();

    const nodesRadio = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="asset-graph-list-tab"]'),
    ).find(input => input.parentElement?.textContent?.includes("当前展示的项目"))!;
    await act(async () => {
      nodesRadio.click();
    });
    await flush();

    const listReqCard = nodeCard(REQ_2);
    expect(listReqCard.textContent).toContain("课程要求：待独立检验");
    expect(listReqCard.textContent).not.toContain("独立完成");
    expect(listReqCard.textContent).not.toContain("已达到课程要求");
    expect(listReqCard.textContent).toContain("跨课共享证据");
    expect(listReqCard.textContent).toContain(expectedSharedCaption);
    expect(listReqCard.querySelector(`a[href="/opening/courses/${COURSE_ID}"]`)).not.toBeNull();

    const listObsCard = nodeCard(OBS_2);
    expect(listObsCard.textContent).toContain("完成条件：独立完成");
    expect(listObsCard.textContent).toContain("跨课共享证据");
    expect(listObsCard.textContent).toContain(expectedSharedCaption);
  });

  it("Counterexample 3: 404/500 shows retryable error without demo routes or sample data; two consecutive CURSOR_STALE restarts once then stops at recoverable error", async () => {
    const forbiddenDemoRoute = `/${["map", "demo"].join("-")}`;

    // Part A: 500 error -> retryable LoadError, zero sample data, zero demo route
    const transport500: AssetGraphTransport = async () => {
      throw new AssetGraphRequestError("NETWORK", "知识地图服务暂时繁忙，请稍后重试。", 500);
    };
    await renderWorkspace({ transport: transport500 });
    expect(container.textContent).toContain("知识地图服务暂时繁忙，请稍后重试。");
    expect(findButton("重新读取")).toBeTruthy();
    expect(container.querySelectorAll("[data-node-card]")).toHaveLength(0);
    expect(container.innerHTML).not.toContain(forbiddenDemoRoute);

    // Part B: 404 error on roots -> retryable LoadError, zero sample data, zero demo route
    const transport404: AssetGraphTransport = async () => {
      throw new AssetGraphRequestError("NOT_FOUND", "请求的资源不可用。", 404);
    };
    await renderWorkspace({ transport: transport404 });
    expect(container.textContent).toContain("所选内容不可用或不在当前范围");
    expect(findButton("重新读取")).toBeTruthy();
    expect(container.querySelectorAll("[data-node-card]")).toHaveLength(0);
    expect(container.innerHTML).not.toContain(forbiddenDemoRoute);

    // Part C: Two consecutive CURSOR_STALE -> 1st auto-restarts roots, 2nd stops at recoverable LoadError without infinite loop
    let rootsCallCount = 0;
    let failWithStale = false;
    const staleTransport: AssetGraphTransport = async query => {
      rootsCallCount += 1;
      if (!failWithStale && query.op === "roots" && !query.cursor) {
        return {
          asOf: "2026-03-10T00:00:00.000Z",
          nodes: [{ id: SOURCE_1_ID, kind: "source", label: "物理化学实验指导" }],
          edges: [],
          page: { nextCursor: "cursor-page-2" },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      throw new AssetGraphRequestError(
        "CURSOR_STALE",
        "分页上下文已失效，请重新读取当前内容。",
        409,
      );
    };

    await renderWorkspace({
      transport: staleTransport,
      initialLens: "assets",
      initialPageLimit: 1,
    });
    expect(rootsCallCount).toBe(1);
    expect(nodeCard(SOURCE_1_ID).textContent).toContain("物理化学实验指导");

    failWithStale = true;
    await act(async () => {
      findButton("加载下一页").click();
    });
    await flush();

    // 1 initial + 1 loadMoreRoots + 1 auto-restart = 3 calls total (no infinite loop)
    expect(rootsCallCount).toBe(3);
    expect(container.textContent).toContain("分页上下文已失效，请重新读取当前内容。");
    expect(findButton("重新读取")).toBeTruthy();
    expect(container.innerHTML).not.toContain(forbiddenDemoRoute);

    // Clicking retry recovers once backend returns valid page
    failWithStale = false;
    await act(async () => {
      findButton("重新读取").click();
    });
    await flush();
    expect(rootsCallCount).toBe(4);
    expect(nodeCard(SOURCE_1_ID).textContent).toContain("物理化学实验指导");
  });

  it("locks initial nodes sub-tab in 0-edge List view on expansion so focused expand button is not unmounted, while allowing manual sub-tab switches", async () => {
    const transport: AssetGraphTransport = async query => {
      if (query.op === "neighbors" && query.focus === REQ_ID) {
        return {
          asOf: "2026-03-11T00:00:00.000Z",
          nodes: [
            { id: REQ_ID, kind: "requirement", label: "酸碱滴定终点判断" },
            { id: SOURCE_1_ID, kind: "source", label: "分析化学实验教材", meta: { version: 1 } },
            {
              id: OBS_ID,
              kind: "observation",
              label: "滴定实验练习记录",
              meta: { occurredAt: "2026-03-10T10:15:00.000Z", assistance: "independent" },
            },
          ],
          edges: [
            {
              id: "list-edge-source",
              from: REQ_ID,
              to: SOURCE_1_ID,
              relation: "usesSource",
              basis: "recorded",
              page: 19,
            },
            {
              id: "list-edge-obs",
              from: REQ_ID,
              to: OBS_ID,
              relation: "hasObservation",
              basis: "derived",
            },
          ],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      return {
        asOf: "2026-03-11T00:00:00.000Z",
        nodes: [{ id: REQ_ID, kind: "requirement", label: "酸碱滴定终点判断" }],
        edges: [],
        page: { nextCursor: null },
        completeness: "complete",
        warnings: [],
        detail: null,
      };
    };

    await renderWorkspace({
      transport,
      initialViewMode: "list",
    });

    // Starts on nodes sub-tab when 0 edges exist
    expect(container.querySelector("[data-list-view]")).not.toBeNull();
    expect(container.querySelector('table[aria-label="已展开关联列表"]')).toBeNull();

    const expandOutButton = findButton("查看材料与记录", nodeCard(REQ_ID));
    expandOutButton.focus();
    expect(document.activeElement).toBe(expandOutButton);

    await act(async () => {
      expandOutButton.click();
    });
    await flush();

    // Remains on nodes sub-tab; original expand control stays mounted and retains focus
    expect(container.querySelector('table[aria-label="已展开关联列表"]')).toBeNull();
    expect(expandOutButton.isConnected).toBe(true);
    expect(findButton("查看材料与记录", nodeCard(REQ_ID))).toBe(expandOutButton);
    expect(document.activeElement).toBe(expandOutButton);
    expect(nodeCard(SOURCE_1_ID).textContent).toContain("分析化学实验教材");

    // Learner can still manually switch to Relations and Timeline sub-tabs
    const relationsRadio = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="asset-graph-list-tab"]'),
    ).find(input => input.parentElement?.textContent?.includes("关联列表（2）"))!;
    await act(async () => {
      relationsRadio.click();
    });
    await flush();
    expect(container.querySelector('table[aria-label="已展开关联列表"]')?.textContent).toContain(
      "第 19 页",
    );

    const timelineRadio = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="asset-graph-list-tab"]'),
    ).find(input => input.parentElement?.textContent?.includes("练习时间线（1）"))!;
    await act(async () => {
      timelineRadio.click();
    });
    await flush();
    expect(container.querySelector("[data-list-view]")?.textContent).toContain("滴定实验练习记录");
  });

  it("does not announce stale expansion success to screen readers when a subsequent expansion on the same node fails with 500", async () => {
    const transport: AssetGraphTransport = async query => {
      if (query.op === "neighbors" && query.focus === REQ_ID && query.direction === "out") {
        return {
          asOf: "2026-03-11T00:00:00.000Z",
          nodes: [
            { id: REQ_ID, kind: "requirement", label: "氧化还原配平规则" },
            { id: SOURCE_1_ID, kind: "source", label: "无机化学基础讲义" },
          ],
          edges: [
            {
              id: "sr-out-edge",
              from: REQ_ID,
              to: SOURCE_1_ID,
              relation: "usesSource",
              basis: "recorded",
            },
          ],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      if (query.op === "neighbors" && query.focus === REQ_ID && query.direction === "in") {
        throw new AssetGraphRequestError("NETWORK", "入边关联读取失败，请稍后重试。", 500);
      }
      return {
        asOf: "2026-03-11T00:00:00.000Z",
        nodes: [{ id: REQ_ID, kind: "requirement", label: "氧化还原配平规则" }],
        edges: [],
        page: { nextCursor: null },
        completeness: "complete",
        warnings: [],
        detail: null,
      };
    };

    await renderWorkspace({ transport });

    const srLiveRegion = () =>
      container.querySelector<HTMLElement>('.sr-only[role="status"][aria-live="polite"]')!;

    // 1) Outgoing expansion succeeds -> announces 1 source item
    await act(async () => {
      findButton("出边展开", nodeCard(REQ_ID)).click();
    });
    await flush();
    expect(srLiveRegion().textContent).toBe("已展开 1 项学习资料");

    // 2) Incoming expansion on the SAME node fails with 500 -> shows LoadError and MUST NOT announce old center success
    await act(async () => {
      findButton("入边探索", nodeCard(REQ_ID)).click();
    });
    await flush();

    expect(container.textContent).toContain("入边关联读取失败，请稍后重试。");
    expect(findButton("重新读取")).toBeTruthy();
    expect(srLiveRegion().textContent).toBe("");
    expect(srLiveRegion().textContent).not.toContain("已展开");
    expect(srLiveRegion().textContent).not.toContain("项学习资料");
  });

  it("restores focus on same-button disabled blur, and never pulls focus back to A after moving to B detail with disabled blur", async () => {
    let resolveExpandA!: (page: AssetGraphPage) => void;
    let resolveDetailB!: (page: AssetGraphPage) => void;
    let expandAttempt = 0;

    const transport: AssetGraphTransport = async query => {
      if (query.op === "roots") {
        return {
          asOf: "2026-03-12T00:00:00.000Z",
          nodes: [
            { id: REQ_ID, kind: "requirement", label: "要求 A：酯化反应条件" },
            { id: DOC_ID, kind: "document", label: "笔记 B：实验安全要点" },
          ],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      if (query.op === "neighbors" && query.focus === REQ_ID) {
        expandAttempt += 1;
        return new Promise<AssetGraphPage>(resolve => {
          resolveExpandA = resolve;
        });
      }
      if (query.op === "detail" && query.focus === DOC_ID) {
        return new Promise<AssetGraphPage>(resolve => {
          resolveDetailB = resolve;
        });
      }
      throw new Error(`Unexpected query: ${JSON.stringify(query)}`);
    };

    await renderWorkspace({
      transport,
      initialViewMode: "list",
    });

    function simulateDisabledBlur(button: HTMLButtonElement) {
      const wasDisabled = button.disabled;
      button.disabled = false;
      button.blur();
      button.disabled = wasDisabled;
    }

    // (a) Same button A expand -> explicit blur() simulates browser disabled-button focus drop -> restores focus to A on completion
    const expandButtonA = findButton("查看材料与记录", nodeCard(REQ_ID));
    expandButtonA.focus();
    expect(document.activeElement).toBe(expandButtonA);

    await act(async () => {
      expandButtonA.click();
    });
    expect(expandButtonA.disabled).toBe(true);
    // Explicitly simulate browser dropping focus to body when button becomes disabled
    act(() => {
      simulateDisabledBlur(expandButtonA);
    });
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      resolveExpandA({
        asOf: "2026-03-12T00:00:01.000Z",
        nodes: [
          { id: REQ_ID, kind: "requirement", label: "要求 A：酯化反应条件" },
          { id: SOURCE_1_ID, kind: "source", label: "有机化学教材" },
        ],
        edges: [
          {
            id: "focus-edge-1",
            from: REQ_ID,
            to: SOURCE_1_ID,
            relation: "usesSource",
            basis: "recorded",
          },
        ],
        page: { nextCursor: null },
        completeness: "complete",
        warnings: [],
        detail: null,
      });
    });
    await flush();

    expect(expandAttempt).toBe(1);
    expect(expandButtonA.disabled).toBe(false);
    expect(document.activeElement).toBe(expandButtonA);

    // (b) Trigger a second expand on A, blur A, then move focus to B "查看详情", click B and blur B -> MUST NOT pull focus back to A
    const expandInButtonA = findButton("追溯所属目标", nodeCard(REQ_ID));
    expandInButtonA.focus();
    expect(document.activeElement).toBe(expandInButtonA);

    await act(async () => {
      expandInButtonA.click();
    });
    expect(expandInButtonA.disabled).toBe(true);
    act(() => {
      simulateDisabledBlur(expandInButtonA);
    });
    expect(document.activeElement).toBe(document.body);

    const detailButtonB = findButton("查看详情", nodeCard(DOC_ID));
    act(() => {
      detailButtonB.focus();
    });
    expect(document.activeElement).toBe(detailButtonB);

    await act(async () => {
      detailButtonB.click();
    });
    expect(detailButtonB.disabled).toBe(true);
    act(() => {
      simulateDisabledBlur(detailButtonB);
    });
    expect(document.activeElement).toBe(document.body);

    // Must NEVER pull focus back to A when A's expanding state clears due to B's detail request
    expect(document.activeElement).not.toBe(expandInButtonA);
    expect(document.activeElement).not.toBe(expandButtonA);

    // Resolve B detail and even settle stale A promise -> focus must still never snap back to A
    await act(async () => {
      resolveDetailB({
        asOf: "2026-03-12T00:00:02.000Z",
        nodes: [{ id: DOC_ID, kind: "document", label: "笔记 B：实验安全要点" }],
        edges: [],
        page: { nextCursor: null },
        completeness: "complete",
        warnings: [],
        detail: {
          id: DOC_ID,
          learnerState: null,
          requirementStatus: null,
          notes: ["实验安全预习摘要"],
          actions: [],
        },
      });
      resolveExpandA({
        asOf: "2026-03-12T00:00:02.000Z",
        nodes: [{ id: REQ_ID, kind: "requirement", label: "要求 A：酯化反应条件" }],
        edges: [],
        page: { nextCursor: null },
        completeness: "complete",
        warnings: [],
        detail: null,
      });
    });
    await flush();

    expect(container.textContent).toContain("实验安全预习摘要");
    expect(document.activeElement).not.toBe(expandInButtonA);
    expect(document.activeElement).not.toBe(expandButtonA);
  });

  it("locks list default sub-tab only after initial data is ready and falls back focus from body when focused card unmounts via 404 or privacy invalidation", async () => {
    let resolveInitialRoots!: (page: AssetGraphPage) => void;
    let rootsCount = 0;

    const transport: AssetGraphTransport = async query => {
      if (query.op === "roots") {
        rootsCount += 1;
        if (rootsCount === 1) {
          return new Promise<AssetGraphPage>(resolve => {
            resolveInitialRoots = resolve;
          });
        }
        return {
          asOf: "2026-03-12T00:00:10.000Z",
          nodes: [{ id: SOURCE_1_ID, kind: "source", label: "隐私更新后可见资料" }],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      if (query.op === "detail" && query.focus === DOC_ID) {
        throw new AssetGraphRequestError("NOT_FOUND", "资源已不可用", 404);
      }
      return {
        asOf: "2026-03-12T00:00:05.000Z",
        nodes: [{ id: GOAL_ID, kind: "goal", label: "目标范围起点" }],
        edges: [],
        page: { nextCursor: null },
        completeness: "complete",
        warnings: [],
        detail: null,
      };
    };

    // Start in graph mode while roots is still loading, click "列表" before data resolves -> must NOT prematurely lock to "nodes"
    await act(async () => {
      root.render(createElement(AssetGraphWorkspace, { transport }));
    });
    const viewToolbar = container.querySelector('[aria-label="视图模式"]')!;
    await act(async () => {
      findButton("列表", viewToolbar).click();
    });

    // Now initial roots resolves WITH an edge -> list view should default to "relations" (not prematurely locked "nodes")
    await act(async () => {
      resolveInitialRoots({
        asOf: "2026-03-12T00:00:00.000Z",
        nodes: [
          { id: REQ_ID, kind: "requirement", label: "第3章 有机反应：酯化" },
          { id: DOC_ID, kind: "document", label: "待移除实验笔记" },
        ],
        edges: [
          {
            id: "initial-edge-1",
            from: DOC_ID,
            to: REQ_ID,
            relation: "linkedTo",
            basis: "recorded",
          },
        ],
        page: { nextCursor: null },
        completeness: "complete",
        warnings: [],
        detail: null,
      });
    });
    await flush();

    expect(container.querySelector('table[aria-label="已展开关联列表"]')).not.toBeNull();

    // Switch to nodes sub-tab, focus button on DOC_ID card, trigger 404 -> card unmounts and focus moves off body to stable notice container
    const nodesRadio = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="asset-graph-list-tab"]'),
    ).find(input => input.parentElement?.textContent?.includes("当前展示的项目"))!;
    await act(async () => {
      nodesRadio.click();
    });
    await flush();

    const docDetailBtn = findButton("查看详情", nodeCard(DOC_ID));
    act(() => {
      docDetailBtn.focus();
    });
    expect(document.activeElement).toBe(docDetailBtn);

    await act(async () => {
      docDetailBtn.click();
    });
    await flush();

    expect(container.querySelector(`[data-node-card="${DOC_ID}"]`)).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement | null)?.getAttribute("tabindex")).toBe("-1");

    // Focus button on remaining REQ_ID card, trigger privacy invalidation -> card unmounts and focus lands on stable tabIndex=-1 container
    const reqDetailBtn = findButton("查看详情", nodeCard(REQ_ID));
    act(() => {
      reqDetailBtn.focus();
    });
    expect(document.activeElement).toBe(reqDetailBtn);

    await act(async () => {
      notifyOpeningPrivacyChange();
    });
    await flush();

    expect(container.querySelector(`[data-node-card="${REQ_ID}"]`)).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement | null)?.getAttribute("tabindex")).toBe("-1");
  });

  it("announces added relation records instead of new source items when cross-page pagination returns the same source with a new page citation", async () => {
    const transport: AssetGraphTransport = async query => {
      if (query.op === "roots") {
        return {
          asOf: "2026-03-12T00:00:00.000Z",
          nodes: [{ id: REQ_ID, kind: "requirement", label: "酯化反应机理" }],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      if (query.op === "neighbors" && query.cursor === "dup-source-page-2") {
        return {
          asOf: "2026-03-12T00:00:02.000Z",
          nodes: [
            { id: REQ_ID, kind: "requirement", label: "酯化反应机理" },
            { id: SOURCE_1_ID, kind: "source", label: "有机化学实验讲义" },
          ],
          edges: [
            {
              id: "dup-edge-p24",
              from: REQ_ID,
              to: SOURCE_1_ID,
              relation: "usesSource",
              basis: "recorded",
              sourceVersion: 1,
              page: 24,
            },
          ],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      return {
        asOf: "2026-03-12T00:00:00.000Z",
        nodes: [
          { id: REQ_ID, kind: "requirement", label: "酯化反应机理" },
          { id: SOURCE_1_ID, kind: "source", label: "有机化学实验讲义" },
        ],
        edges: [
          {
            id: "dup-edge-p11",
            from: REQ_ID,
            to: SOURCE_1_ID,
            relation: "usesSource",
            basis: "recorded",
            sourceVersion: 1,
            page: 11,
          },
        ],
        page: { nextCursor: "dup-source-page-2" },
        completeness: "complete",
        warnings: [],
        detail: null,
      };
    };

    await renderWorkspace({ transport });

    const srLiveRegion = () =>
      container.querySelector<HTMLElement>('.sr-only[role="status"][aria-live="polite"]')!;

    await act(async () => {
      findButton("出边展开", nodeCard(REQ_ID)).click();
    });
    await flush();
    expect(srLiveRegion().textContent).toBe("已展开 1 项学习资料");

    // Load page 2 returning the SAME source node with a new page-24 edge
    await act(async () => {
      findButton("加载更多关联", nodeCard(REQ_ID)).click();
    });
    await flush();

    expect(srLiveRegion().textContent).toBe("已补充 1 条关联记录");
    expect(srLiveRegion().textContent).not.toBe("已展开 1 项学习资料");
  });

  it("Case 21 adversarial combination: REQ_2 with cross-course learnerState='independent' and requirementStatus='needs_verification' shows 待独立检验 without claiming 已达到课程要求 before and after loading activeDetail", async () => {
    const COURSE_2 = "10000000-0000-4000-8000-000000000002";
    const REQ_2 = "requirement/30000000-0000-4000-8000-000000000002" as const;
    const sharedPage = fixturePage("synthetic-shared-skills-01-cross-course-evidence-neighbors");
    const req2Label = fixtureNodeLabel(REQ_2);
    const sharedAttr = sharedPage.edges[0]!.sharedAttribution!;
    const expectedSharedCaption = `跨课共享自「${sharedAttr.sourceCourseTitle} · ${sharedAttr.sourceRequirementTitle}」（第 ${sharedAttr.sourceRequirementRevision} 版）`;

    const transport: AssetGraphTransport = async query => {
      if (query.op === "detail" && query.focus === REQ_2) {
        return {
          asOf: "2026-03-12T00:00:05.000Z",
          nodes: [
            {
              id: REQ_2,
              kind: "requirement",
              label: req2Label,
              summary: {
                learnerState: "independent",
                requirementStatus: "needs_verification",
              },
            },
          ],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: {
            id: REQ_2,
            learnerState: "independent",
            requirementStatus: "needs_verification",
            notes: ["跨课共享练习记录可供参考，但本课仍需完成一次独立检验。"],
            actions: [
              {
                kind: "startCourseRequirement",
                label: "在本课完成独立检验",
                courseId: COURSE_2,
                goalId: "20000000-0000-4000-8000-000000000002",
                requirementId: "30000000-0000-4000-8000-000000000002",
                expectedGoalRevision: 1,
                expectedRequirementRevision: 1,
              },
            ],
          },
        };
      }
      if (query.op === "neighbors" && query.focus === REQ_2) {
        return {
          ...sharedPage,
          nodes: sharedPage.nodes.map(node =>
            node.id === REQ_2
              ? {
                  ...node,
                  summary: {
                    learnerState: "independent",
                    requirementStatus: "needs_verification",
                  },
                }
              : node,
          ),
        };
      }
      return {
        asOf: "2026-03-12T00:00:00.000Z",
        nodes: [
          {
            id: REQ_2,
            kind: "requirement",
            label: req2Label,
            summary: {
              learnerState: "independent",
              requirementStatus: "needs_verification",
            },
          },
        ],
        edges: [],
        page: { nextCursor: null },
        completeness: "complete",
        warnings: [],
        detail: null,
      };
    };

    await renderWorkspace({
      transport,
      initialContext: { kind: "course", id: `course/${COURSE_2}` },
      initialLens: "evidence",
      courses: [
        { id: COURSE_ID, title: sharedAttr.sourceCourseTitle },
        { id: COURSE_2, title: "有机合成进阶" },
      ],
    });

    await act(async () => {
      findButton("出边展开", nodeCard(REQ_2)).click();
    });
    await flush();

    // Before loading activeDetail: card, SVG node, and aside all show 待独立检验 and never 已达到课程要求
    const reqSvgNode = container.querySelector(`[data-graph-node="${REQ_2}"]`)!;
    expect(reqSvgNode.textContent).toContain("待独立检验");
    expect(reqSvgNode.textContent).not.toContain("已达到课程要求");

    const reqCardBeforeDetail = nodeCard(REQ_2);
    expect(reqCardBeforeDetail.textContent).toContain("练习状态：独立完成");
    expect(reqCardBeforeDetail.textContent).toContain("课程要求：待独立检验");
    expect(reqCardBeforeDetail.textContent).not.toContain("已达到课程要求");
    expect(reqCardBeforeDetail.textContent).toContain(expectedSharedCaption);

    // Load activeDetail for REQ_2 and verify right detail panel and card stay completely consistent
    await act(async () => {
      findButton("查看详情", nodeCard(REQ_2)).click();
    });
    await flush();

    const detailAside = container.querySelector('aside[aria-label="详情与后续行动面板"]')!;
    expect(detailAside.textContent).toContain("独立完成");
    expect(detailAside.textContent).toContain("待独立检验");
    expect(detailAside.textContent).not.toContain("已达到课程要求");
    expect(detailAside.textContent).toContain("跨课共享练习记录可供参考，但本课仍需完成一次独立检验。");
    expect(detailAside.textContent).toContain("在本课完成独立检验");

    const reqCardAfterDetail = nodeCard(REQ_2);
    expect(reqCardAfterDetail.textContent).toContain("练习状态：独立完成");
    expect(reqCardAfterDetail.textContent).toContain("课程要求：待独立检验");
    expect(reqCardAfterDetail.textContent).not.toContain("已达到课程要求");

    // Verify List view Nodes tab consistency with activeDetail loaded
    const viewToolbar = container.querySelector('[aria-label="视图模式"]')!;
    await act(async () => {
      findButton("列表", viewToolbar).click();
    });
    await flush();
    const nodesRadio = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="asset-graph-list-tab"]'),
    ).find(input => input.parentElement?.textContent?.includes("当前展示的项目"))!;
    await act(async () => {
      nodesRadio.click();
    });
    await flush();

    const listReqCard = nodeCard(REQ_2);
    expect(listReqCard.textContent).toContain("练习状态：独立完成");
    expect(listReqCard.textContent).toContain("课程要求：待独立检验");
    expect(listReqCard.textContent).not.toContain("已达到课程要求");
  });

  it("clears derived note D and pinned comparison, reloads visible roots, and falls back focus safely on neighbor NOT_FOUND", async () => {
    let sourceDeleted = false;
    const transport: AssetGraphTransport = async query => {
      if (query.op === "roots") {
        if (sourceDeleted) {
          return {
            asOf: "2026-03-13T00:05:00.000Z",
            nodes: [{ id: SOURCE_2_ID, kind: "source", label: "仍可见的有机化学参考书" }],
            edges: [],
            page: { nextCursor: null },
            completeness: "complete",
            warnings: [],
            detail: null,
          };
        }
        return {
          asOf: "2026-03-13T00:00:00.000Z",
          nodes: [
            { id: SOURCE_1_ID, kind: "source", label: "待删除资料 S" },
            { id: DOC_ID, kind: "document", label: "引用 S 的派生笔记 D" },
            { id: SOURCE_2_ID, kind: "source", label: "仍可见的有机化学参考书" },
          ],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      if (query.op === "neighbors" && query.focus === SOURCE_1_ID) {
        throw new AssetGraphRequestError("NOT_FOUND", "请求的资源不可用。", 404);
      }
      throw new Error(`Unexpected query: ${JSON.stringify(query)}`);
    };

    await renderWorkspace({ transport });

    // Pin derived note D for comparison
    await act(async () => {
      findButton("固定对比", nodeCard(DOC_ID)).click();
    });
    await flush();
    expect(container.querySelector('section[aria-label="对比参考卡片"]')?.textContent).toContain(
      "引用 S 的派生笔记 D",
    );

    // Focus expand button on source S, delete S on server, click expand -> 404 NOT_FOUND
    const expandSourceBtn = findButton("入边探索", nodeCard(SOURCE_1_ID));
    act(() => {
      expandSourceBtn.focus();
    });
    expect(document.activeElement).toBe(expandSourceBtn);

    sourceDeleted = true;
    await act(async () => {
      expandSourceBtn.click();
    });
    await flush();

    // S, derived note D, and pinned comparison are gone; reloaded visible source remains; safe 404 notice shown; focus falls back off body
    expect(container.querySelector(`[data-node-card="${SOURCE_1_ID}"]`)).toBeNull();
    expect(container.querySelector(`[data-node-card="${DOC_ID}"]`)).toBeNull();
    expect(container.querySelector('section[aria-label="对比参考卡片"]')).toBeNull();
    expect(nodeCard(SOURCE_2_ID).textContent).toContain("仍可见的有机化学参考书");
    expect(container.textContent).toContain("所选内容不可用或不在当前范围");
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement | null)?.getAttribute("tabindex")).toBe("-1");
  });

  it("surfaces full-course 1A exam picker, protects verified+due retest task binding, and uses 15-min ordinary practice preset", async () => {
    const REQ_BOUND_UUID = "30000000-0000-4000-8000-000000000011";
    const REQ_UNBOUND_UUID = "30000000-0000-4000-8000-000000000012";
    const REQ_UNOBS_UUID = "30000000-0000-4000-8000-000000000013";
    const REQ_BLOCKED_UUID = "30000000-0000-4000-8000-000000000014";
    const TASK_BOUND_UUID = "90000000-0000-4000-8000-000000000011";
    const TASK_UNBOUND_UUID = "90000000-0000-4000-8000-000000000012";
    const GOAL_UUID = "20000000-0000-4000-8000-000000000001";
    const SKILL_1 = "40000000-0000-4000-8000-000000000011";
    const SKILL_2 = "40000000-0000-4000-8000-000000000012";
    const SKILL_3 = "40000000-0000-4000-8000-000000000013";
    const SKILL_4 = "40000000-0000-4000-8000-000000000014";
    const ACTIVITY_ID = "80000000-0000-4000-8000-000000000099";

    const makeReq = (id: string, skillId: string, title: string, position: number) => ({
      id,
      courseId: COURSE_ID,
      stableSkillId: skillId,
      knowledgeNodeId: null,
      requirementKey: `req-${position}`,
      title,
      position,
      mandatory: true,
      goalIds: [GOAL_UUID],
      prerequisiteIds: [],
      sourceRefs: [],
      verification: {
        kind: "manual" as const,
        status: "ready" as const,
        exerciseKeys: [],
        rubric: null,
        missingReasons: [],
      },
      origin: "confirmed" as const,
      revision: 2,
      lifecycle: "active" as const,
      approvedAt: "2026-03-01T00:00:00.000Z",
    });

    const confirmedSnapshot: CourseRouteSnapshot = {
      courseId: COURSE_ID,
      scopeState: "confirmed",
      requirements: [
        {
          requirement: makeReq(REQ_BOUND_UUID, SKILL_1, "级数比较判别法", 0),
          status: "verified",
          observationId: null,
          missingReasons: [],
          sourcesAvailable: true,
          delayedCheck: {
            status: "pending",
            retestId: "70000000-0000-4000-8000-000000000011",
            taskId: TASK_BOUND_UUID,
            notBeforeAt: "2026-03-01T00:00:00.000Z",
          },
        },
        {
          requirement: makeReq(REQ_UNBOUND_UUID, SKILL_2, "比值判别法边界", 1),
          status: "verified",
          observationId: null,
          missingReasons: [],
          sourcesAvailable: true,
          delayedCheck: {
            status: "pending",
            retestId: "70000000-0000-4000-8000-000000000012",
            taskId: TASK_UNBOUND_UUID,
            notBeforeAt: "2026-03-01T00:00:00.000Z",
          },
        },
        {
          requirement: makeReq(REQ_UNOBS_UUID, SKILL_3, "交错级数莱布尼茨判别", 2),
          status: "unobserved",
          observationId: null,
          missingReasons: [],
          sourcesAvailable: true,
        },
        {
          requirement: makeReq(REQ_BLOCKED_UUID, SKILL_4, "待补齐材料的幂级数展开", 3),
          status: "blocked",
          observationId: null,
          missingReasons: ["缺少本课对应教材页"],
          sourcesAvailable: false,
        },
      ],
      suggestions: [],
      summary: { total: 4, mandatory: 4, verified: 2, blocked: 1 },
      materials: [],
      currentActivity: null,
      currentRoute: null,
      observationId: null,
    };

    const startSpy = vi.fn<CourseRouteClient["start"]>(
      async (): Promise<CourseRouteActionResult> => ({
        kind: "ready",
        activity: {
          id: ACTIVITY_ID,
          courseId: COURSE_ID,
          title: "复测活动",
          status: "active",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
        } as unknown as TeachingActivity,
        href: `/opening/courses/${COURSE_ID}/study?activity=${ACTIVITY_ID}`,
        resumed: false,
        requirementId: REQ_BOUND_UUID,
        action: "transfer_check",
      }),
    );

    const readSpy = vi.fn(async () => confirmedSnapshot);
    const taskSpy = vi.fn(async (_courseId: string, taskId: string): Promise<CourseRouteTaskContext> => {
      if (taskId === TASK_BOUND_UUID) {
        return {
          managed: true,
          courseId: COURSE_ID,
          taskId: TASK_BOUND_UUID,
          expectedTaskVersion: 3,
          goalId: GOAL_UUID,
          expectedGoalRevision: 5,
          requirementId: REQ_BOUND_UUID,
          expectedRequirementRevision: 2,
          minutes: 10,
          notBeforeAt: "2026-03-01T00:00:00.000Z",
          available: true,
          reason: null,
        };
      }
      return {
        managed: true,
        courseId: COURSE_ID,
        taskId: TASK_UNBOUND_UUID,
        expectedTaskVersion: 4,
        goalId: GOAL_UUID,
        expectedGoalRevision: 5,
        requirementId: REQ_UNBOUND_UUID,
        expectedRequirementRevision: 2,
        minutes: 10,
        notBeforeAt: "2026-03-01T00:00:00.000Z",
        available: false,
        reason: "请从今日任务进入完成这次独立复测。",
      };
    });

    const navigated: string[] = [];
    const transport: AssetGraphTransport = async query => {
      if (query.op === "roots") {
        return {
          asOf: "2026-03-02T00:00:00.000Z",
          nodes: [
            { id: `course/${COURSE_ID}`, kind: "course", label: "高等数学 · 级数" },
            { id: `requirement/${REQ_BOUND_UUID}`, kind: "requirement", label: "级数比较判别法" },
          ],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      if (query.op === "detail" && query.focus === `requirement/${REQ_UNOBS_UUID}`) {
        return {
          asOf: "2026-03-02T00:00:00.000Z",
          nodes: [
            { id: `requirement/${REQ_UNOBS_UUID}`, kind: "requirement", label: "交错级数莱布尼茨判别" },
          ],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: {
            id: `requirement/${REQ_UNOBS_UUID}`,
            kind: "requirement",
            learnerState: null,
            requirementStatus: "unobserved",
            notes: [],
            actions: [
              {
                kind: "startCourseRequirement",
                label: "开始本项练习",
                courseId: COURSE_ID,
                goalId: GOAL_UUID,
                expectedGoalRevision: 5,
                requirementId: REQ_UNOBS_UUID,
                expectedRequirementRevision: 2,
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected query: ${JSON.stringify(query)}`);
    };

    await renderWorkspace({
      transport,
      courseRouteClient: { start: startSpy, read: readSpy, task: taskSpy },
      initialContext: { kind: "course", id: `course/${COURSE_ID}` },
      onNavigate: href => navigated.push(href),
    });
    await flush();

    // Full denominator and separate blocked surfacing
    const examPanel = container.querySelector("[data-exam-picker-panel]")!;
    expect(examPanel.textContent).toContain("全课共 4 项要求，已验证 2 项");
    expect(examPanel.querySelector("[data-blocked-requirements-banner]")?.textContent).toContain(
      "另有 1 项要求因材料待补齐暂不可直接开练",
    );
    expect(examPanel.querySelector(`[data-exam-picker-item="${REQ_BLOCKED_UUID}"]`)).toBeNull();

    // Bound verified+due retest item renders "开始独立复测" and sends taskId + expectedTaskVersion + taskContext.minutes
    const boundCard = examPanel.querySelector<HTMLElement>(
      `[data-exam-picker-item="${REQ_BOUND_UUID}"]`,
    )!;
    expect(boundCard.getAttribute("data-exam-bucket")).toBe("due_retest");
    const boundRetestBtn = findButton("开始独立复测", boundCard);
    await act(async () => {
      boundRetestBtn.click();
    });
    await flush();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[1]).toMatchObject({
      goalId: GOAL_UUID,
      expectedGoalRevision: 5,
      requirementId: REQ_BOUND_UUID,
      expectedRequirementRevision: 2,
      taskId: TASK_BOUND_UUID,
      expectedTaskVersion: 3,
      minutes: 10,
    });
    expect(navigated[0]).toBe(`/opening/courses/${COURSE_ID}/study?activity=${ACTIVITY_ID}`);

    // Unbound verified+due retest MUST NOT be labeled "开始独立复测"
    const unboundCard = examPanel.querySelector<HTMLElement>(
      `[data-exam-picker-item="${REQ_UNBOUND_UUID}"]`,
    )!;
    expect(unboundCard.textContent).not.toContain("开始独立复测");
    expect(unboundCard.querySelector('a[href="/opening/today"]')).not.toBeNull();
    expect(unboundCard.textContent).toContain("按 15 分钟普通练习开始（不替代复测任务）");

    // Ordinary 1A practice loads detail and starts with 15-min preset and NO taskId
    const unobsCard = examPanel.querySelector<HTMLElement>(
      `[data-exam-picker-item="${REQ_UNOBS_UUID}"]`,
    )!;
    const locateBtn = findButton("在图中定位这项要求", unobsCard);
    await act(async () => {
      locateBtn.click();
    });
    await flush();
    expect(container.querySelector(`[data-graph-node="requirement/${REQ_UNOBS_UUID}"]`)).not.toBeNull();

    const ordinaryBtn = findButton("开始 15 分钟练习", unobsCard);
    await act(async () => {
      ordinaryBtn.click();
    });
    await flush();
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(startSpy.mock.calls[1]?.[1]).toMatchObject({
      requirementId: REQ_UNOBS_UUID,
      minutes: 15,
    });
    expect(startSpy.mock.calls[1]?.[1]).not.toHaveProperty("taskId");
  });

  it("persists 2A paper-review checklist in sessionStorage with undo, next round, and privacy-change clearing, and isolates Series Sandbox", async () => {
    window.sessionStorage.clear();
    const disposeIdentity = publishVerifiedSessionIdentity({
      id: "user-map-1",
      workspaceId: "ws-map-1",
    });
    try {

    const REQ_A_UUID = "30000000-0000-4000-8000-000000000021";
    const SKILL_A = "40000000-0000-4000-8000-000000000021";
    const GOAL_UUID = "20000000-0000-4000-8000-000000000001";

    const snapshot: CourseRouteSnapshot = {
      courseId: COURSE_ID,
      scopeState: "confirmed",
      requirements: [
        {
          requirement: {
            id: REQ_A_UUID,
            courseId: COURSE_ID,
            stableSkillId: SKILL_A,
            knowledgeNodeId: null,
            requirementKey: "req-a",
            title: "收敛必要条件",
            position: 0,
            mandatory: true,
            goalIds: [GOAL_UUID],
            prerequisiteIds: [],
            sourceRefs: [],
            verification: {
              kind: "manual",
              status: "ready",
              exerciseKeys: [],
              rubric: null,
              missingReasons: [],
            },
            origin: "confirmed",
            revision: 1,
            lifecycle: "active",
            approvedAt: "2026-03-01T00:00:00.000Z",
          },
          status: "unobserved",
          observationId: null,
          missingReasons: [],
          sourcesAvailable: true,
        },
      ],
      suggestions: [],
      summary: { total: 1, mandatory: 1, verified: 0, blocked: 0 },
      materials: [],
      currentActivity: null,
      currentRoute: null,
      observationId: null,
    };

    const transportSpy = vi.fn<AssetGraphTransport>(async query => {
      if (query.op === "roots") {
        return {
          asOf: "2026-03-02T00:00:00.000Z",
          nodes: [{ id: `course/${COURSE_ID}`, kind: "course", label: "高等数学 · 级数" }],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      throw new Error(`Unexpected query: ${JSON.stringify(query)}`);
    });

    await renderWorkspace({
      transport: transportSpy,
      courseRouteClient: {
        start: vi.fn(),
        read: vi.fn(async () => snapshot),
      },
      initialContext: { kind: "course", id: `course/${COURSE_ID}` },
    });
    await flush();

    // Toggle 2A paper-review checkbox
    const itemCard = container.querySelector<HTMLElement>(
      `[data-exam-picker-item="${REQ_A_UUID}"]`,
    )!;
    const checkbox = itemCard.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    await act(async () => {
      checkbox.click();
    });
    await flush();
    expect(checkbox.checked).toBe(true);
    expect(container.querySelector("[data-paper-review-bar]")?.textContent).toContain(
      "本轮纸上已复习 1 / 1 项",
    );
    const storageKey = `aistudy:paper-review:v1:user-map-1:ws-map-1:course:${COURSE_ID}`;
    expect(window.sessionStorage.getItem(storageKey)).toContain(REQ_A_UUID);

    // Undo restores unmarked state
    await act(async () => {
      findButton("撤销上一步", container.querySelector("[data-paper-review-bar]")!).click();
    });
    await flush();
    expect(checkbox.checked).toBe(false);

    // Re-check then start next round
    await act(async () => {
      checkbox.click();
    });
    await flush();
    await act(async () => {
      findButton("开启新一轮纸上核对", container.querySelector("[data-paper-review-bar]")!).click();
    });
    await flush();
    expect(container.querySelector("[data-paper-review-bar]")?.textContent).toContain(
      "第 2 轮纸上复习",
    );

    // Privacy change clears sessionStorage
    await act(async () => {
      notifyOpeningPrivacyChange();
    });
    await flush();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();

    // Enter explicit Series Sandbox: badged, zero server writes, clean exit
    const callsBeforeSandbox = transportSpy.mock.calls.length;
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-open-series-sandbox]")!.click();
    });
    await flush();
    expect(container.textContent).toContain("示例沙盒 · 不计入个人课程记录");
    expect(transportSpy.mock.calls.length).toBe(callsBeforeSandbox);

    await act(async () => {
      findButton("返回真实地图", container).click();
    });
    await flush();
    expect(container.querySelector("[data-exam-picker-panel]")).not.toBeNull();
    } finally {
      disposeIdentity();
    }
  });

  it("renders distinct knowledgeStatus (supported, needs_check, suggested) across canvas, list view, and sidebar", async () => {
    const K1 = `knowledge/${COURSE_ID}/50000000-0000-4000-8000-000000000001` as const;
    const K2 = `knowledge/${COURSE_ID}/50000000-0000-4000-8000-000000000002` as const;
    const K3 = `knowledge/${COURSE_ID}/50000000-0000-4000-8000-000000000003` as const;
    const K4 = `knowledge/${COURSE_ID}/50000000-0000-4000-8000-000000000004` as const;
    const SRC = "source/60000000-0000-4000-8000-000000000001" as const;

    const transport: AssetGraphTransport = async query => {
      if (query.op === "roots") {
        return {
          asOf: "2026-03-02T00:00:00.000Z",
          nodes: [{ id: K1, kind: "knowledge", label: "正项级数" }],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      if (query.op === "neighbors" && query.focus === K1) {
        return {
          asOf: "2026-03-02T00:00:00.000Z",
          nodes: [
            { id: K1, kind: "knowledge", label: "正项级数" },
            { id: K2, kind: "knowledge", label: "比较判别法" },
            { id: K3, kind: "knowledge", label: "积分判别法" },
            { id: K4, kind: "knowledge", label: "柯西凝聚判别法" },
          ],
          edges: [
            {
              id: "e-supported",
              from: K1,
              to: K2,
              relation: "prerequisite",
              basis: "recorded",
              knowledgeStatus: "supported",
              sourceNodeId: SRC,
              sourceVersion: 2,
              page: 18,
            },
            {
              id: "e-needs-check",
              from: K1,
              to: K3,
              relation: "appliesTo",
              basis: "recorded",
              knowledgeStatus: "needs_check",
            },
            {
              id: "e-suggested",
              from: K1,
              to: K4,
              relation: "prerequisite",
              basis: "suggested",
              knowledgeStatus: "suggested",
            },
          ],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      throw new Error(`Unexpected query: ${JSON.stringify(query)}`);
    };

    await renderWorkspace({ transport });
    await act(async () => {
      findButton("出边展开", nodeCard(K1)).click();
    });
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent ?? "").toBe("");
    const supportedPath = container.querySelector(
      'svg [data-free-map-edge="e-supported"][data-knowledge-status="supported"] path',
    );
    expect(supportedPath).not.toBeNull();
    expect(supportedPath?.getAttribute("stroke-dasharray")).toBeNull();
    expect(
      container
        .querySelector('svg [data-free-map-edge="e-needs-check"][data-knowledge-status="needs_check"] path')
        ?.getAttribute("stroke-dasharray"),
    ).toBe("6 4");
    expect(
      container
        .querySelector('svg [data-free-map-edge="e-suggested"][data-knowledge-status="suggested"] path')
        ?.getAttribute("stroke-dasharray"),
    ).toBe("3 4");

    // Sidebar ConnectedEdgeItem shows all three statuses distinctly plus verified version/page
    const sidebar = container.querySelector('aside[aria-label="详情与后续行动面板"]')!;
    expect(sidebar.textContent).toContain("已佐证");
    expect(sidebar.textContent).toContain("资料第 2 版");
    expect(sidebar.textContent).toContain("第 18 页");
    expect(sidebar.textContent).toContain("待核对");
    expect(sidebar.textContent).toContain("待确认建议");

    // List View Relations table shows all three statuses distinctly
    const viewToolbar = container.querySelector('[aria-label="视图模式"]')!;
    await act(async () => {
      findButton("列表", viewToolbar).click();
    });
    await flush();
    const relationsTable = container.querySelector('table[aria-label="已展开关联列表"]')!;
    expect(relationsTable.querySelector('[data-knowledge-status="supported"]')?.textContent).toContain(
      "已佐证",
    );
    expect(relationsTable.querySelector('[data-knowledge-status="needs_check"]')?.textContent).toContain(
      "待核对",
    );
    expect(relationsTable.querySelector('[data-knowledge-status="suggested"]')?.textContent).toContain(
      "待确认建议",
    );
  });
});
