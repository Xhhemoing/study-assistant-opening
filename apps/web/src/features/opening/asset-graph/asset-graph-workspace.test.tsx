// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseRouteActionResult, TeachingActivity } from "@aistudy/contracts";
import { notifyOpeningPrivacyChange } from "../client/privacy-change";
import type { CourseRouteClient } from "../courses/course-route-client";
import {
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
    intentSummary: "变化率练习",
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
    expect(container.textContent).toContain("合成：理解示例课程中的变化率");
    expect(container.textContent).toContain("合成：从自由探索整理的个人笔记（未关联课程）");

    // Enter goal scope (Case 3)
    await act(async () => {
      findButton("进入目标范围", nodeCard(GOAL_ID)).click();
    });
    await flush();
    expect(container.textContent).toContain("合成：解释平均变化率与瞬时变化率");

    // Expand requirement outgoing neighbors (Case 4)
    await act(async () => {
      findButton("出边展开", nodeCard(REQ_ID)).click();
    });
    await flush();
    expect(container.textContent).toContain("合成：变化率讲义");
    expect(container.textContent).toContain("合成：提示后完成一次变化率练习");

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
      setInput.call(searchInput, "合成：从自由探索整理的个人笔记");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(nodeCard(DOC_ID).textContent).toContain("合成：从自由探索整理的个人笔记（未关联课程）");

    // Incoming expansion (Case 10)
    await act(async () => {
      findButton("入边探索", nodeCard(DOC_ID)).click();
    });
    await flush();
    expect(nodeCard(EXP_ID).textContent).toContain("合成：观察日常变化的自由探索");

    // Exploration detail (Case 11)
    await act(async () => {
      findButton("查看详情", nodeCard(EXP_ID)).click();
    });
    await flush();
    expect(container.textContent).toContain("合成探索：开放状态，未关联课程或学习目标。");
    expect(container.textContent).toContain("当前节点暂无可直接打开的后续入口。");
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
    expect(container.textContent).toContain("合成：变化率讲义");
    expect(container.textContent).toContain("合成：提示后完成一次变化率练习");

    // Switch to assets lens (Case 5) -> requirement stays focused, shows source only
    await act(async () => {
      findButton("材料与笔记").click();
    });
    await flush();
    expect(nodeCard(REQ_ID).querySelector("button[aria-pressed='true']")).not.toBeNull();
    expect(container.textContent).toContain("合成：变化率讲义");
    expect(container.textContent).not.toContain("合成：提示后完成一次变化率练习");

    // Switch to evidence lens: requirement stays focused, shows observation only
    await act(async () => {
      findButton("练习记录").click();
    });
    await flush();
    expect(nodeCard(REQ_ID).querySelector("button[aria-pressed='true']")).not.toBeNull();
    expect(nodeCard(OBS_ID).textContent).toContain("合成：提示后完成一次变化率练习");
    expect(container.textContent).not.toContain("合成：变化率讲义");
  });

  it("supports roots pagination and recovers from 409 CURSOR_STALE", async () => {
    const baseTransport = createSyntheticAssetGraphTransport(fixtures);
    let injectStaleOnce = false;
    const transport: AssetGraphTransport = async (query, signal) => {
      if (query.op === "roots" && query.cursor === "synthetic-source-roots-page-2-v1" && injectStaleOnce) {
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
    expect(nodeCard(SOURCE_2_ID).textContent).toContain("合成：变化率练习资料");
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
    expect(container.textContent).toContain("合成：解释平均变化率与瞬时变化率");

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
    expect(container.querySelector(`a[href="/opening/courses/${COURSE_ID}#course-learning-route"]`)).not.toBeNull();
    expect(container.textContent).not.toContain("已达到课程要求");
  });
});
