import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AssetGraphDetail,
  AssetGraphNode,
  AssetGraphPage,
  AssetGraphQuery,
} from "@aistudy/contracts";
import {
  AssetGraphRequestError,
  createAssetGraphClient,
  createSyntheticAssetGraphTransport,
  type AssetGraphTransport,
  type SyntheticAssetGraphFixtures,
} from "./asset-graph-client";
import {
  LEARNER_STATE_LABELS,
  NOT_FOUND_SAFE_NOTICE,
  REQUIREMENT_STATUS_LABELS,
  applyNotFoundForFocus,
  collapseExpandedNode,
  collectGraphWarnings,
  createAssetGraphStore,
  describeZeroExpansion,
  getVisibleEdges,
  getVisibleNodes,
  isGraphPartial,
  isZeroNeighborResult,
  resolveEffectiveNodeStates,
  summarizeExpansionForScreenReader,
  togglePinnedComparison,
} from "./asset-graph-model";

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

const UNSCOPED_DOC_QUERY = String(
  (fixtureCase("synthetic-unscoped-01-workspace-document-roots").request.body as { q?: string }).q,
);

const GOAL_ID = "goal/20000000-0000-4000-8000-000000000001" as const;
const REQ_ID = "requirement/30000000-0000-4000-8000-000000000001" as const;
const SOURCE_1_ID = "source/40000000-0000-4000-8000-000000000001" as const;
const SOURCE_2_ID = "source/40000000-0000-4000-8000-000000000002" as const;
const OBS_ID = "observation/50000000-0000-4000-8000-000000000001" as const;
const DOC_ID = "document/60000000-0000-4000-8000-000000000001" as const;
const EXP_ID = "exploration/70000000-0000-4000-8000-000000000001" as const;

describe("asset graph status labels & pure helpers", () => {
  it("distinguishes learnerState and requirementStatus without ever claiming inability to learn", () => {
    expect(LEARNER_STATE_LABELS).toEqual({
      independent: "独立完成",
      hinted: "提示后完成",
      retest: "待复测",
      insufficient: "记录较少",
    });
    expect(REQUIREMENT_STATUS_LABELS).toEqual({
      unobserved: "尚无练习记录",
      needs_correction: "待纠错",
      assisted: "曾受助",
      needs_verification: "待独立检验",
      verified: "已达到课程要求",
      blocked: "材料待补齐",
    });
    for (const label of [
      ...Object.values(LEARNER_STATE_LABELS),
      ...Object.values(REQUIREMENT_STATUS_LABELS),
    ]) {
      expect(label).not.toContain("学不会");
    }
  });

  it("prioritizes detail over summary in resolveEffectiveNodeStates including explicit null", () => {
    const summaryNode: AssetGraphNode = {
      id: REQ_ID,
      kind: "requirement",
      label: "有机反应机理分析",
      summary: {
        learnerState: "independent",
        requirementStatus: "verified",
      },
    };

    expect(resolveEffectiveNodeStates(summaryNode, null)).toEqual({
      hasDetail: false,
      learnerState: "independent",
      requirementStatus: "verified",
    });

    const explicitNullDetail: AssetGraphDetail = {
      id: REQ_ID,
      learnerState: null,
      requirementStatus: null,
      actions: [],
    };
    expect(resolveEffectiveNodeStates(summaryNode, explicitNullDetail)).toEqual({
      hasDetail: true,
      learnerState: null,
      requirementStatus: null,
    });

    const needsVerificationDetail: AssetGraphDetail = {
      id: REQ_ID,
      learnerState: "independent",
      requirementStatus: "needs_verification",
      actions: [],
    };
    expect(resolveEffectiveNodeStates(summaryNode, needsVerificationDetail)).toEqual({
      hasDetail: true,
      learnerState: "independent",
      requirementStatus: "needs_verification",
    });
  });

  it("formats screen-reader expansion summaries and zero-neighbor descriptions in learner-friendly Chinese", () => {
    const nodes: AssetGraphNode[] = [
      { id: REQ_ID, kind: "requirement", label: "酯化反应条件" },
      { id: SOURCE_1_ID, kind: "source", label: "有机化学教材" },
      { id: OBS_ID, kind: "observation", label: "课后练习记录" },
    ];
    expect(summarizeExpansionForScreenReader(nodes, REQ_ID)).toBe(
      "已展开 1 项学习资料、1 项练习记录",
    );
    expect(summarizeExpansionForScreenReader([nodes[0]!], REQ_ID, 2)).toBe(
      "已补充 2 条关联记录",
    );
    expect(summarizeExpansionForScreenReader([nodes[0]!], REQ_ID, 0)).toBe(
      "已更新关联，暂无新增学习资料",
    );

    expect(
      isZeroNeighborResult({
        direction: "out",
        nodeIds: [REQ_ID],
        edgeIds: [],
        nextCursor: null,
        completeness: "complete",
        warnings: [],
      }),
    ).toBe(true);
    expect(
      isZeroNeighborResult({
        direction: "out",
        nodeIds: [REQ_ID],
        edgeIds: [],
        nextCursor: "more-1",
        completeness: "complete",
        warnings: [],
      }),
    ).toBe(false);

    expect(describeZeroExpansion("document", "in", "assets")).toContain("独立笔记本身仍是有效起点");
    expect(describeZeroExpansion("requirement", "out", "evidence")).toContain(
      "暂时没有展开的关联内容",
    );
  });
});

describe("createAssetGraphStore", () => {
  it("supports goal drill-down, multi-center retention, summary toggle, and detail loading", async () => {
    const store = createAssetGraphStore(
      createAssetGraphClient(createSyntheticAssetGraphTransport(fixtures)),
    );

    await store.initialize();
    expect(store.getState().rootIds).toEqual([GOAL_ID, DOC_ID]);

    // Drill into goal context -> expands goal scopes (Case 3)
    await store.selectContext({ kind: "goal", id: GOAL_ID });
    expect(store.getState().context).toEqual({ kind: "goal", id: GOAL_ID });
    expect(store.getState().expandedCenters[GOAL_ID]?.direction).toBe("out");
    expect(Object.keys(store.getState().nodesById)).toEqual(
      expect.arrayContaining([GOAL_ID, REQ_ID]),
    );

    // Expand requirement while keeping goal center expanded (Case 4)
    await store.expandNode(REQ_ID, "out");
    const afterReqExpand = store.getState();
    expect(Object.keys(afterReqExpand.expandedCenters)).toEqual(
      expect.arrayContaining([GOAL_ID, REQ_ID]),
    );
    expect(Object.keys(afterReqExpand.nodesById)).toEqual(
      expect.arrayContaining([GOAL_ID, REQ_ID, SOURCE_1_ID, OBS_ID]),
    );
    expect(afterReqExpand.nodesById[REQ_ID]?.summary).toBeUndefined();

    // Toggle summary on -> requests include: ["summary"] for focused requirement (Case 4b)
    await store.setIncludeSummary(true);
    expect(store.getState().nodesById[REQ_ID]?.summary).toEqual({
      learnerState: "hinted",
      requirementStatus: "assisted",
    });

    // Load requirement detail (Case 8)
    await store.loadDetail(REQ_ID);
    expect(store.getState().detail?.actions[0]).toMatchObject({
      kind: "startCourseRequirement",
      requirementId: "30000000-0000-4000-8000-000000000001",
    });
  });

  it("supports unscoped workspace document incoming promotion traceback", async () => {
    const store = createAssetGraphStore(
      createAssetGraphClient(createSyntheticAssetGraphTransport(fixtures)),
      { lens: "assets" },
    );

    await store.applyFilters({
      selectedKinds: ["document"],
      searchQuery: UNSCOPED_DOC_QUERY,
    });
    expect(store.getState().rootIds).toEqual([DOC_ID]);

    await store.expandNode(DOC_ID, "in");
    const afterIncoming = store.getState();
    expect(Object.keys(afterIncoming.nodesById)).toEqual(expect.arrayContaining([DOC_ID, EXP_ID]));
    expect(getVisibleEdges(afterIncoming)).toMatchObject([
      {
        from: EXP_ID,
        to: DOC_ID,
        relation: "promotedTo",
        basis: "recorded",
      },
    ]);

    await store.loadDetail(EXP_ID);
    expect(store.getState().detail).toMatchObject({
      id: EXP_ID,
      learnerState: null,
      requirementStatus: null,
      actions: [],
    });
  });

  it("collapses expanded center cleanly while retaining anchored nodes and falling back leaf focus", async () => {
    const store = createAssetGraphStore(
      createAssetGraphClient(createSyntheticAssetGraphTransport(fixtures)),
      { context: { kind: "goal", id: GOAL_ID }, lens: "all" },
    );

    await store.initialize();
    await store.expandNode(REQ_ID, "out");
    store.focusNode(OBS_ID);
    expect(store.getState().selectedNodeId).toBe(OBS_ID);

    const collapsed = collapseExpandedNode(store.getState(), REQ_ID);
    expect(collapsed.expandedCenters[REQ_ID]).toBeUndefined();
    expect(collapsed.expandedCenters[GOAL_ID]).toBeDefined();
    expect(collapsed.nodesById[REQ_ID]).toBeDefined();
    expect(collapsed.nodesById[GOAL_ID]).toBeDefined();
    expect(collapsed.nodesById[OBS_ID]).toBeUndefined();
    expect(collapsed.nodesById[SOURCE_1_ID]).toBeUndefined();
    expect(collapsed.selectedNodeId).toBe(REQ_ID);
  });

  it("supports togglePinnedComparison, sanitizes pinned summary across lens switch, and evicts on 404", async () => {
    const store = createAssetGraphStore(
      createAssetGraphClient(createSyntheticAssetGraphTransport(fixtures)),
      { context: { kind: "goal", id: GOAL_ID }, lens: "all", includeSummary: true },
    );

    await store.initialize();
    await store.expandNode(REQ_ID, "out");
    await store.loadDetail(REQ_ID);

    const pinnedState = togglePinnedComparison(store.getState(), REQ_ID);
    expect(pinnedState.pinnedComparison?.node.id).toBe(REQ_ID);
    expect(pinnedState.pinnedComparison?.detail?.id).toBe(REQ_ID);

    const unpinnedState = togglePinnedComparison(pinnedState, REQ_ID);
    expect(unpinnedState.pinnedComparison).toBeNull();

    // Via store: pin REQ_ID, switch lens -> keeps pinned identity but strips stale summary/detail
    store.togglePinNode(REQ_ID);
    expect(store.getState().pinnedComparison?.node.summary).toBeDefined();
    await store.selectLens("assets");
    expect(store.getState().pinnedComparison?.node.id).toBe(REQ_ID);
    expect(store.getState().pinnedComparison?.node.summary).toBeUndefined();
    expect(store.getState().pinnedComparison?.detail).toBeNull();

    // Evicts pinned node if 404 arrives for that node
    const after404 = applyNotFoundForFocus(store.getState(), REQ_ID);
    expect(after404.pinnedComparison).toBeNull();
  });

  it("preserves focused center identity across lens switches while clearing old lens data", async () => {
    const store = createAssetGraphStore(
      createAssetGraphClient(createSyntheticAssetGraphTransport(fixtures)),
      { context: { kind: "goal", id: GOAL_ID }, lens: "all" },
    );

    await store.initialize();
    await store.expandNode(REQ_ID, "out");
    await store.loadDetail(REQ_ID);
    expect(store.getState().selectedNodeId).toBe(REQ_ID);
    expect(store.getState().detail?.id).toBe(REQ_ID);
    expect(Object.keys(store.getState().nodesById)).toEqual(
      expect.arrayContaining([REQ_ID, SOURCE_1_ID, OBS_ID]),
    );

    // Switch to assets lens: keeps requirement focus, clears old detail/observation, loads source only
    await store.selectLens("assets");
    expect(store.getState().lens).toBe("assets");
    expect(store.getState().selectedNodeId).toBe(REQ_ID);
    expect(store.getState().detail).toBeNull();
    expect(Object.keys(store.getState().nodesById)).toEqual([REQ_ID, SOURCE_1_ID]);
    expect(store.getState().nodesById[OBS_ID]).toBeUndefined();

    // Switch to evidence lens: keeps requirement focus, clears source, loads observation only
    await store.selectLens("evidence");
    expect(store.getState().lens).toBe("evidence");
    expect(store.getState().selectedNodeId).toBe(REQ_ID);
    expect(Object.keys(store.getState().nodesById)).toEqual([REQ_ID, OBS_ID]);
    expect(store.getState().nodesById[SOURCE_1_ID]).toBeUndefined();
  });

  it("handles 409 CURSOR_STALE on roots and neighbors by restarting the exact operation once", async () => {
    const baseTransport = createSyntheticAssetGraphTransport(fixtures);
    let injectedStaleOnce = false;
    const staleCursorTransport: AssetGraphTransport = async (query, signal) => {
      if (
        query.op === "roots" &&
        query.cursor === "synthetic-source-roots-page-2-v1" &&
        !injectedStaleOnce
      ) {
        injectedStaleOnce = true;
        return baseTransport({ ...query, cursor: "synthetic-expired-source-roots-v0" }, signal);
      }
      return baseTransport(query, signal);
    };

    const store = createAssetGraphStore(createAssetGraphClient(staleCursorTransport), {
      lens: "assets",
      selectedKinds: ["source"],
      pageLimit: 1,
    });

    await store.initialize();
    expect(store.getState().rootIds).toEqual([SOURCE_1_ID]);
    expect(store.getState().rootsCursor).toBe("synthetic-source-roots-page-2-v1");
    const genAfterPage1 = store.getState().requestGeneration;

    await store.loadMoreRoots();
    const afterStaleRestart = store.getState();
    expect(afterStaleRestart.requestGeneration).toBeGreaterThan(genAfterPage1);
    expect(afterStaleRestart.rootIds).toEqual([SOURCE_1_ID]);
    expect(afterStaleRestart.rootsCursor).toBe("synthetic-source-roots-page-2-v1");
    expect(afterStaleRestart.notice).toContain("重新读取");

    // Second pagination attempt succeeds and appends page 2
    await store.loadMoreRoots();
    expect(store.getState().rootIds).toEqual([SOURCE_1_ID, SOURCE_2_ID]);
    expect(store.getState().rootsCursor).toBeNull();

    // Exact-operation restart on loadMoreNeighbors CURSOR_STALE clears unverified rootIds and old nodes
    let neighborStaleOnce = false;
    const recordedQueries: AssetGraphQuery[] = [];
    const neighborTransport: AssetGraphTransport = async query => {
      recordedQueries.push(query);
      if (query.op === "roots") {
        return {
          asOf: "2026-01-01T00:00:00.000Z",
          nodes: [
            { id: DOC_ID, kind: "document", label: "实验预习笔记" },
            { id: REQ_ID, kind: "requirement", label: "第3章 有机反应：酯化" },
          ],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      if (query.op === "neighbors" && query.cursor === "nbr-page-2" && !neighborStaleOnce) {
        neighborStaleOnce = true;
        throw new AssetGraphRequestError("CURSOR_STALE", "分页游标已过期", 409);
      }
      return {
        asOf: "2026-01-01T00:00:00.000Z",
        nodes: [
          { id: REQ_ID, kind: "requirement", label: "第3章 有机反应：酯化" },
          { id: SOURCE_1_ID, kind: "source", label: "有机化学实验讲义" },
        ],
        edges: [
          {
            id: `recorded:usesSource:${REQ_ID}:${SOURCE_1_ID}`,
            from: REQ_ID,
            to: SOURCE_1_ID,
            relation: "usesSource",
            basis: "recorded",
          },
        ],
        page: { nextCursor: query.op !== "detail" && query.cursor ? null : "nbr-page-2" },
        completeness: "complete",
        warnings: [],
        detail: null,
      };
    };

    const neighborStore = createAssetGraphStore(createAssetGraphClient(neighborTransport));
    await neighborStore.initialize();
    expect(neighborStore.getState().rootIds).toEqual([DOC_ID, REQ_ID]);
    await neighborStore.expandNode(REQ_ID, "out", { relations: ["usesSource"] });
    expect(neighborStore.getState().expandedCenters[REQ_ID]?.nextCursor).toBe("nbr-page-2");

    const reloadResult = await neighborStore.loadMoreNeighbors(REQ_ID);
    expect(reloadResult).toMatchObject({
      applied: true,
      focusId: REQ_ID,
      direction: "out",
      addedNodeCount: 1,
      addedEdgeCount: 1,
      addedCount: 1,
    });
    const lastQuery = recordedQueries.at(-1);
    expect(lastQuery).toMatchObject({
      op: "neighbors",
      focus: REQ_ID,
      direction: "out",
      relations: ["usesSource"],
    });
    expect((lastQuery as { cursor?: string }).cursor).toBeUndefined();
    expect(neighborStore.getState().error).toBeNull();
    expect(neighborStore.getState().rootIds).toEqual([]);
    expect(neighborStore.getState().rootEdgeIds).toEqual([]);
    expect(neighborStore.getState().nodesById[DOC_ID]).toBeUndefined();
    expect(neighborStore.getState().nodesById[REQ_ID]).toBeDefined();
    expect(neighborStore.getState().nodesById[SOURCE_1_ID]).toBeDefined();
  });

  it("evicts invalid focus node, adjacent edges, and center expansion on 404 NOT_FOUND before any retry", async () => {
    const store = createAssetGraphStore(
      createAssetGraphClient(createSyntheticAssetGraphTransport(fixtures)),
      { lens: "assets" },
    );

    await store.applyFilters({
      selectedKinds: ["document"],
      searchQuery: UNSCOPED_DOC_QUERY,
    });
    await store.expandNode(DOC_ID, "in");
    expect(getVisibleNodes(store.getState()).map(n => n.id)).toEqual([DOC_ID, EXP_ID]);
    expect(getVisibleEdges(store.getState())).toHaveLength(1);

    const evictedState = applyNotFoundForFocus(store.getState(), DOC_ID);
    expect(evictedState.nodesById[DOC_ID]).toBeUndefined();
    expect(evictedState.nodesById[EXP_ID]).toBeDefined();
    expect(evictedState.rootIds).toEqual([]);
    expect(evictedState.expandedCenters[DOC_ID]).toBeUndefined();
    expect(getVisibleEdges(evictedState)).toHaveLength(0);
    expect(evictedState.selectedNodeId).toBeNull();
    expect(evictedState.notice).toBe(NOT_FOUND_SAFE_NOTICE);

    // Live 404 detail query in goal context (Case 19)
    const goalStore = createAssetGraphStore(
      createAssetGraphClient(createSyntheticAssetGraphTransport(fixtures)),
      { context: { kind: "goal", id: GOAL_ID }, lens: "all" },
    );
    await goalStore.initialize();
    await goalStore.loadDetail(DOC_ID);
    expect(goalStore.getState().notice).toBe(NOT_FOUND_SAFE_NOTICE);
    expect(goalStore.getState().selectedNodeId).toBeNull();
    expect(goalStore.getState().nodesById[GOAL_ID]).toBeDefined();
  });

  it("discards stale out-of-order responses using requestGeneration", async () => {
    let resolveSlowFirst!: (page: AssetGraphPage) => void;
    let callCount = 0;

    const deferredTransport: AssetGraphTransport = async (_query: AssetGraphQuery) => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<AssetGraphPage>(resolve => {
          resolveSlowFirst = resolve;
        });
      }
      return {
        asOf: "2026-01-01T00:00:00.000Z",
        nodes: [
          {
            id: DOC_ID,
            kind: "document",
            label: "最新视角结果",
          },
        ],
        edges: [],
        page: { nextCursor: null },
        completeness: "complete",
        warnings: [],
        detail: null,
      };
    };

    const store = createAssetGraphStore(createAssetGraphClient(deferredTransport));
    const slowPromise = store.loadRoots();
    await store.selectLens("assets");
    expect(store.getState().rootIds).toEqual([DOC_ID]);
    expect(store.getState().nodesById[DOC_ID]?.label).toBe("最新视角结果");

    resolveSlowFirst({
      asOf: "2026-01-01T00:00:00.000Z",
      nodes: [{ id: GOAL_ID, kind: "goal", label: "迟到的旧目标" }],
      edges: [],
      page: { nextCursor: null },
      completeness: "complete",
      warnings: [],
      detail: null,
    });
    await slowPromise;

    expect(store.getState().rootIds).toEqual([DOC_ID]);
    expect(store.getState().nodesById[GOAL_ID]).toBeUndefined();
  });

  it("flags partial completeness across pagination, and clears private view on 401/403", async () => {
    const partialStore = createAssetGraphStore(
      createAssetGraphClient(createSyntheticAssetGraphTransport(fixtures)),
      { context: { kind: "goal", id: GOAL_ID }, lens: "structure" },
    );

    await partialStore.initialize();
    expect(isGraphPartial(partialStore.getState())).toBe(true);
    expect(collectGraphWarnings(partialStore.getState())).toEqual([
      "部分适用范围暂未能核对，仅显示已确认的要求关系。",
    ]);

    let failAuth = false;
    const baseTransport = createSyntheticAssetGraphTransport(fixtures);
    const authTransport: AssetGraphTransport = async (query, signal) => {
      if (failAuth) {
        throw new AssetGraphRequestError("FORBIDDEN", "当前账户无权查看。", 403);
      }
      return baseTransport(query, signal);
    };
    const authStore = createAssetGraphStore(createAssetGraphClient(authTransport));
    await authStore.initialize();
    expect(authStore.getState().rootIds).toEqual([GOAL_ID, DOC_ID]);

    failAuth = true;
    await authStore.loadDetail(GOAL_ID);
    expect(authStore.getState().error).toEqual({
      code: "FORBIDDEN",
      message: "当前账户无权查看。",
    });
    expect(authStore.getState().nodesById).toEqual({});
    expect(authStore.getState().rootIds).toEqual([]);
  });

  it("Counterexample 1 (model): preserves real chemistry chapter titles without injecting calculus chapter copy", async () => {
    const chemReqId = "requirement/31000000-0000-4000-8000-000000000003" as const;
    const transport: AssetGraphTransport = async () => ({
      asOf: "2026-03-01T00:00:00.000Z",
      nodes: [
        {
          id: chemReqId,
          kind: "requirement",
          label: "第3章 有机反应：酯化",
        },
      ],
      edges: [],
      page: { nextCursor: null },
      completeness: "complete",
      warnings: [],
      detail: null,
    });

    const store = createAssetGraphStore(createAssetGraphClient(transport));
    await store.initialize();

    const visible = getVisibleNodes(store.getState());
    expect(visible).toEqual([
      {
        id: chemReqId,
        kind: "requirement",
        label: "第3章 有机反应：酯化",
      },
    ]);
    const serialized = JSON.stringify(store.getState());
    expect(serialized).toContain("第3章 有机反应：酯化");
    expect(serialized).not.toContain("微分与 Taylor");
    expect(serialized).not.toContain("积分与微分方程");
  });

  it("Counterexample 3 (model): stops at recoverable error on two consecutive CURSOR_STALE responses without looping", async () => {
    let rootsCalls = 0;
    let alwaysStaleFromNowOn = false;

    const transport: AssetGraphTransport = async query => {
      rootsCalls += 1;
      if (!alwaysStaleFromNowOn && query.op === "roots" && !query.cursor) {
        return {
          asOf: "2026-03-01T00:00:00.000Z",
          nodes: [{ id: SOURCE_1_ID, kind: "source", label: "有机化学讲义（上）" }],
          edges: [],
          page: { nextCursor: "page-2-cursor" },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      throw new AssetGraphRequestError(
        "CURSOR_STALE",
        "分页上下文已失效，请从第 1 页重新读取。",
        409,
      );
    };

    const store = createAssetGraphStore(createAssetGraphClient(transport), {
      lens: "assets",
      selectedKinds: ["source"],
      pageLimit: 1,
    });

    await store.initialize();
    expect(rootsCalls).toBe(1);
    expect(store.getState().rootsCursor).toBe("page-2-cursor");

    // Next pagination call fails with CURSOR_STALE, AND the automatic page-1 restart also fails with CURSOR_STALE
    alwaysStaleFromNowOn = true;
    await store.loadMoreRoots();

    // Must be bounded: 1 initial + 1 page-2 attempt + 1 automatic page-1 restart = 3 total calls (no loop)
    expect(rootsCalls).toBe(3);
    expect(store.getState().error).toEqual({
      code: "CURSOR_STALE",
      message: "分页上下文已失效，请从第 1 页重新读取。",
    });
    expect(store.getState().lastFailedOperation).toEqual({ op: "roots" });

    // Recoverable when backend stabilizes and learner triggers retryCurrentView
    alwaysStaleFromNowOn = false;
    await store.retryCurrentView();
    expect(rootsCalls).toBe(4);
    expect(store.getState().error).toBeNull();
    expect(store.getState().rootIds).toEqual([SOURCE_1_ID]);
  });

  it("keeps filtered roots pagination in goal scope on roots when CURSOR_STALE occurs, and bounds consecutive CURSOR_STALE to 3 requests", async () => {
    const recordedQueries: AssetGraphQuery[] = [];
    let staleMode: "page2-once" | "always" | "off" = "page2-once";

    const transport: AssetGraphTransport = async query => {
      recordedQueries.push(query);
      if (query.op !== "roots") {
        throw new Error(`Unexpected query op in filtered goal roots flow: ${query.op}`);
      }
      if (staleMode === "always") {
        throw new AssetGraphRequestError(
          "CURSOR_STALE",
          "目标范围筛选游标已失效，请重新读取。",
          409,
        );
      }
      if (staleMode === "page2-once" && query.cursor === "goal-filtered-roots-p2") {
        staleMode = "off";
        throw new AssetGraphRequestError(
          "CURSOR_STALE",
          "目标范围筛选游标已失效，请重新读取。",
          409,
        );
      }
      if (query.cursor === "goal-filtered-roots-p2") {
        return {
          asOf: "2026-03-02T00:00:00.000Z",
          nodes: [{ id: SOURCE_2_ID, kind: "source", label: "有机合成实验讲义（下）" }],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      return {
        asOf: "2026-03-02T00:00:00.000Z",
        nodes: [{ id: SOURCE_1_ID, kind: "source", label: "有机合成实验讲义（上）" }],
        edges: [],
        page: { nextCursor: "goal-filtered-roots-p2" },
        completeness: "complete",
        warnings: [],
        detail: null,
      };
    };

    // Part A: Single CURSOR_STALE in goal scope restarts filtered roots page 1 without switching to neighbors
    const store = createAssetGraphStore(createAssetGraphClient(transport), {
      context: { kind: "goal", id: GOAL_ID },
      lens: "assets",
    });

    await store.applyFilters({
      searchQuery: "实验讲义",
      selectedKinds: ["source"],
      pageLimit: 1,
    });
    expect(store.getState().rootIds).toEqual([SOURCE_1_ID]);
    expect(store.getState().rootsCursor).toBe("goal-filtered-roots-p2");

    await store.loadMoreRoots();

    expect(recordedQueries).toHaveLength(3);
    expect(recordedQueries[0]).toMatchObject({
      op: "roots",
      context: { kind: "goal", id: GOAL_ID },
      lens: "assets",
      q: "实验讲义",
      kinds: ["source"],
      limit: 1,
    });
    expect((recordedQueries[0] as { cursor?: string }).cursor).toBeUndefined();
    expect(recordedQueries[1]).toMatchObject({
      op: "roots",
      context: { kind: "goal", id: GOAL_ID },
      lens: "assets",
      q: "实验讲义",
      kinds: ["source"],
      limit: 1,
      cursor: "goal-filtered-roots-p2",
    });
    expect(recordedQueries[2]).toMatchObject({
      op: "roots",
      context: { kind: "goal", id: GOAL_ID },
      lens: "assets",
      q: "实验讲义",
      kinds: ["source"],
      limit: 1,
    });
    expect((recordedQueries[2] as { cursor?: string }).cursor).toBeUndefined();
    expect(store.getState().searchQuery).toBe("实验讲义");
    expect(store.getState().selectedKinds).toEqual(["source"]);
    expect(store.getState().rootIds).toEqual([SOURCE_1_ID]);
    expect(store.getState().rootsCursor).toBe("goal-filtered-roots-p2");
    expect(store.getState().error).toBeNull();

    // Part B: Consecutive CURSOR_STALE in goal-scoped filtered roots stops at 3 total calls in recoverable error state
    recordedQueries.length = 0;
    staleMode = "off";
    const boundedStore = createAssetGraphStore(createAssetGraphClient(transport), {
      context: { kind: "goal", id: GOAL_ID },
      lens: "assets",
    });

    await boundedStore.applyFilters({
      searchQuery: "实验讲义",
      selectedKinds: ["source"],
      pageLimit: 1,
    });
    expect(recordedQueries).toHaveLength(1);

    staleMode = "always";
    await boundedStore.loadMoreRoots();

    expect(recordedQueries).toHaveLength(3);
    expect(recordedQueries.map(item => item.op)).toEqual(["roots", "roots", "roots"]);
    expect((recordedQueries[2] as { cursor?: string }).cursor).toBeUndefined();
    expect(boundedStore.getState().searchQuery).toBe("实验讲义");
    expect(boundedStore.getState().selectedKinds).toEqual(["source"]);
    expect(boundedStore.getState().lastFailedOperation).toEqual({ op: "roots" });
    expect(boundedStore.getState().error).toEqual({
      code: "CURSOR_STALE",
      message: "目标范围筛选游标已失效，请重新读取。",
    });

    // Manual recovery via retryCurrentView reloads filtered roots page 1 cleanly
    staleMode = "off";
    await boundedStore.retryCurrentView();
    expect(recordedQueries).toHaveLength(4);
    expect(recordedQueries[3]).toMatchObject({
      op: "roots",
      context: { kind: "goal", id: GOAL_ID },
      lens: "assets",
      q: "实验讲义",
      kinds: ["source"],
      limit: 1,
    });
    expect(boundedStore.getState().error).toBeNull();
    expect(boundedStore.getState().rootIds).toEqual([SOURCE_1_ID]);
  });

  it("returns applied=false from expandNode when request errors or is superseded", async () => {
    let failIncoming = false;
    const transport: AssetGraphTransport = async query => {
      if (query.op === "neighbors" && query.direction === "in" && failIncoming) {
        throw new AssetGraphRequestError("NETWORK", "关联服务暂时繁忙", 500);
      }
      return {
        asOf: "2026-03-02T00:00:00.000Z",
        nodes: [
          { id: REQ_ID, kind: "requirement", label: "酯化反应机理" },
          { id: SOURCE_1_ID, kind: "source", label: "有机化学教材" },
        ],
        edges: [
          {
            id: "e-out-1",
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
    };

    const store = createAssetGraphStore(createAssetGraphClient(transport));
    const okResult = await store.expandNode(REQ_ID, "out");
    expect(okResult).toMatchObject({
      applied: true,
      focusId: REQ_ID,
      direction: "out",
      addedCount: 1,
      announcement: "已展开 1 项学习资料",
    });

    failIncoming = true;
    const errResult = await store.expandNode(REQ_ID, "in");
    expect(errResult).toEqual({ applied: false, reason: "error" });
  });

  it("evicts revoked root R, other center edges pointing to R, and pinned comparison on neighbor CURSOR_STALE restart, and bounds consecutive CURSOR_STALE to 3 requests", async () => {
    const REVOKED_ROOT_ID = DOC_ID;
    const oldRootEdgeId = `recorded:linkedTo:${GOAL_ID}:${REVOKED_ROOT_ID}`;
    const otherCenterEdgeId = `recorded:promotedTo:${EXP_ID}:${REVOKED_ROOT_ID}`;
    const reqSourceEdgeId = `recorded:usesSource:${REQ_ID}:${SOURCE_1_ID}`;

    let staleMode: "once" | "always" | "off" = "once";
    const neighborQueries: AssetGraphQuery[] = [];

    const transport: AssetGraphTransport = async query => {
      if (query.op === "roots") {
        return {
          asOf: "2026-03-12T00:00:00.000Z",
          nodes: [
            { id: REVOKED_ROOT_ID, kind: "document", label: "隐私待撤回笔记 R" },
            { id: GOAL_ID, kind: "goal", label: "有机反应机理目标" },
            { id: EXP_ID, kind: "exploration", label: "自由探索草稿" },
            { id: REQ_ID, kind: "requirement", label: "第3章 有机反应：酯化" },
          ],
          edges: [
            {
              id: oldRootEdgeId,
              from: GOAL_ID,
              to: REVOKED_ROOT_ID,
              relation: "linkedTo",
              basis: "recorded",
            },
          ],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      if (query.op === "neighbors" && query.focus === EXP_ID) {
        return {
          asOf: "2026-03-12T00:00:00.000Z",
          nodes: [
            { id: EXP_ID, kind: "exploration", label: "自由探索草稿" },
            { id: REVOKED_ROOT_ID, kind: "document", label: "隐私待撤回笔记 R" },
          ],
          edges: [
            {
              id: otherCenterEdgeId,
              from: EXP_ID,
              to: REVOKED_ROOT_ID,
              relation: "promotedTo",
              basis: "recorded",
            },
          ],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      if (query.op === "neighbors" && query.focus === REQ_ID) {
        neighborQueries.push(query);
        if (staleMode === "always") {
          throw new AssetGraphRequestError("CURSOR_STALE", "邻接分页游标已失效，请重新读取。", 409);
        }
        if (staleMode === "once" && query.cursor === "req-nbr-page-2") {
          staleMode = "off";
          throw new AssetGraphRequestError("CURSOR_STALE", "邻接分页游标已失效，请重新读取。", 409);
        }
        return {
          asOf: "2026-03-12T00:00:05.000Z",
          nodes: [
            { id: REQ_ID, kind: "requirement", label: "第3章 有机反应：酯化" },
            { id: SOURCE_1_ID, kind: "source", label: "有机化学实验讲义" },
          ],
          edges: [
            {
              id: reqSourceEdgeId,
              from: REQ_ID,
              to: SOURCE_1_ID,
              relation: "usesSource",
              basis: "recorded",
            },
          ],
          page: { nextCursor: query.cursor ? null : "req-nbr-page-2" },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      throw new Error(`Unexpected query: ${JSON.stringify(query)}`);
    };

    const store = createAssetGraphStore(createAssetGraphClient(transport));
    await store.initialize();
    await store.expandNode(EXP_ID, "out", { relations: ["promotedTo"] });
    store.togglePinNode(REVOKED_ROOT_ID);
    await store.expandNode(REQ_ID, "out", { relations: ["usesSource"] });

    // Pre-check: R is in roots, pointed to by other center EXP_ID, and pinned for comparison
    expect(store.getState().rootIds).toContain(REVOKED_ROOT_ID);
    expect(store.getState().edgesById[oldRootEdgeId]).toBeDefined();
    expect(store.getState().edgesById[otherCenterEdgeId]).toBeDefined();
    expect(store.getState().pinnedComparison?.node.id).toBe(REVOKED_ROOT_ID);

    // Neighbor page-2 hits CURSOR_STALE -> restarts page 1 without R
    const restartResult = await store.loadMoreNeighbors(REQ_ID);
    expect(restartResult).toMatchObject({
      applied: true,
      focusId: REQ_ID,
      direction: "out",
      addedNodeCount: 1,
      addedEdgeCount: 1,
    });

    const afterRestart = store.getState();
    expect(afterRestart.nodesById[REVOKED_ROOT_ID]).toBeUndefined();
    expect(afterRestart.nodesById[GOAL_ID]).toBeUndefined();
    expect(afterRestart.nodesById[EXP_ID]).toBeUndefined();
    expect(afterRestart.rootIds).toEqual([]);
    expect(afterRestart.rootEdgeIds).toEqual([]);
    expect(afterRestart.edgesById[oldRootEdgeId]).toBeUndefined();
    expect(afterRestart.edgesById[otherCenterEdgeId]).toBeUndefined();
    expect(Object.keys(afterRestart.expandedCenters)).toEqual([REQ_ID]);
    expect(afterRestart.pinnedComparison).toBeNull();
    expect(getVisibleNodes(afterRestart).map(n => n.id)).toEqual([REQ_ID, SOURCE_1_ID]);
    expect(getVisibleEdges(afterRestart).map(e => e.id)).toEqual([reqSourceEdgeId]);

    // Consecutive CURSOR_STALE on neighbors bounds to 3 requests total (page1 + stale page2 + stale restart page1)
    neighborQueries.length = 0;
    staleMode = "off";
    const boundedStore = createAssetGraphStore(createAssetGraphClient(transport));
    await boundedStore.initialize();
    boundedStore.togglePinNode(REVOKED_ROOT_ID);
    await boundedStore.expandNode(REQ_ID, "out", { relations: ["usesSource"] });
    expect(neighborQueries).toHaveLength(1);

    staleMode = "always";
    const failedResult = await boundedStore.loadMoreNeighbors(REQ_ID);
    expect(failedResult).toEqual({ applied: false, reason: "error" });
    expect(neighborQueries).toHaveLength(3);
    expect((neighborQueries[2] as { cursor?: string }).cursor).toBeUndefined();
    expect(boundedStore.getState().nodesById).toEqual({});
    expect(boundedStore.getState().edgesById).toEqual({});
    expect(boundedStore.getState().rootIds).toEqual([]);
    expect(boundedStore.getState().pinnedComparison).toBeNull();
    expect(boundedStore.getState().error).toEqual({
      code: "CURSOR_STALE",
      message: "邻接分页游标已失效，请重新读取。",
    });
    expect(boundedStore.getState().lastFailedOperation).toEqual({
      op: "neighbors",
      focus: REQ_ID,
      direction: "out",
      relations: ["usesSource"],
    });

    staleMode = "off";
    await boundedStore.retryCurrentView();
    expect(neighborQueries).toHaveLength(4);
    expect(boundedStore.getState().error).toBeNull();
    expect(boundedStore.getState().nodesById[SOURCE_1_ID]).toBeDefined();
  });

  it("counts cross-page duplicate source by visible node/edge ID diff so addedNodeCount is 0 and addedEdgeCount is 1", async () => {
    const transport: AssetGraphTransport = async query => {
      if (query.op === "roots") {
        return {
          asOf: "2026-03-12T00:00:00.000Z",
          nodes: [{ id: REQ_ID, kind: "requirement", label: "酯化反应条件" }],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }
      if (query.op === "neighbors" && query.cursor === "same-source-page-2") {
        return {
          asOf: "2026-03-12T00:00:01.000Z",
          nodes: [
            { id: REQ_ID, kind: "requirement", label: "酯化反应条件" },
            { id: SOURCE_1_ID, kind: "source", label: "有机化学教材" },
          ],
          edges: [
            {
              id: "edge-source-p28",
              from: REQ_ID,
              to: SOURCE_1_ID,
              relation: "usesSource",
              basis: "recorded",
              sourceVersion: 1,
              page: 28,
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
          { id: REQ_ID, kind: "requirement", label: "酯化反应条件" },
          { id: SOURCE_1_ID, kind: "source", label: "有机化学教材" },
        ],
        edges: [
          {
            id: "edge-source-p12",
            from: REQ_ID,
            to: SOURCE_1_ID,
            relation: "usesSource",
            basis: "recorded",
            sourceVersion: 1,
            page: 12,
          },
        ],
        page: { nextCursor: "same-source-page-2" },
        completeness: "complete",
        warnings: [],
        detail: null,
      };
    };

    const store = createAssetGraphStore(createAssetGraphClient(transport));
    await store.initialize();

    const page1Result = await store.expandNode(REQ_ID, "out");
    expect(page1Result).toMatchObject({
      applied: true,
      addedNodeCount: 1,
      addedEdgeCount: 1,
      addedCount: 1,
      announcement: "已展开 1 项学习资料",
    });

    // Page 2 returns the SAME SOURCE_1_ID with a new page citation edge
    const page2Result = await store.loadMoreNeighbors(REQ_ID);
    expect(page2Result).toMatchObject({
      applied: true,
      addedNodeCount: 0,
      addedEdgeCount: 1,
      addedCount: 0,
      announcement: "已补充 1 条关联记录",
    });
    if (page2Result.applied) {
      expect(page2Result.announcement).not.toBe("已展开 1 项学习资料");
    }

    // Re-expanding with identical visible nodes and edges announces no-op update
    const noopResult = await store.expandNode(REQ_ID, "out");
    expect(noopResult).toMatchObject({
      applied: true,
      addedNodeCount: 0,
      addedEdgeCount: 0,
      addedCount: 0,
      announcement: "已更新关联，暂无新增学习资料",
    });
  });

  it("clears source S, derived note D, pinnedComparison, and detail immediately on neighbor NOT_FOUND (both paginated and initial expand) and reloads current scope safely", async () => {
    const SOURCE_S = SOURCE_1_ID;
    const DERIVED_NOTE_D = DOC_ID;
    const VISIBLE_REQ = REQ_ID;
    const VISIBLE_SOURCE = SOURCE_2_ID;
    const rootDerivedEdgeId = `recorded:linkedTo:${DERIVED_NOTE_D}:${SOURCE_S}`;
    const neighborEdgeId = `recorded:usesSource:${VISIBLE_REQ}:${SOURCE_S}`;

    let sourceDeleted = false;
    let deferNextRootsReload = false;
    let resolveDeferredReload: ((page: AssetGraphPage) => void) | null = null;
    let signalReloadStarted: (() => void) | null = null;
    let failReloadWith: AssetGraphRequestError | null = null;
    const recordedRootsQueries: AssetGraphQuery[] = [];

    const transport: AssetGraphTransport = async query => {
      if (query.op === "roots") {
        recordedRootsQueries.push(query);
        if (failReloadWith) {
          throw failReloadWith;
        }
        const buildReloadPage = (): AssetGraphPage =>
          sourceDeleted
            ? {
                asOf: "2026-03-13T00:05:00.000Z",
                nodes: [{ id: VISIBLE_SOURCE, kind: "source", label: "仍可见的有机化学参考书" }],
                edges: [],
                page: { nextCursor: null },
                completeness: "complete",
                warnings: [],
                detail: null,
              }
            : {
                asOf: "2026-03-13T00:00:00.000Z",
                nodes: [
                  { id: SOURCE_S, kind: "source", label: "待删除资料 S" },
                  { id: DERIVED_NOTE_D, kind: "document", label: "引用 S 的派生笔记 D" },
                  { id: VISIBLE_SOURCE, kind: "source", label: "仍可见的有机化学参考书" },
                ],
                edges: [
                  {
                    id: rootDerivedEdgeId,
                    from: DERIVED_NOTE_D,
                    to: SOURCE_S,
                    relation: "linkedTo",
                    basis: "recorded",
                  },
                ],
                page: { nextCursor: null },
                completeness: "complete",
                warnings: [],
                detail: null,
              };

        if (deferNextRootsReload) {
          deferNextRootsReload = false;
          signalReloadStarted?.();
          return new Promise<AssetGraphPage>(resolve => {
            resolveDeferredReload = resolve;
          });
        }
        return buildReloadPage();
      }

      if (query.op === "detail" && query.focus === DERIVED_NOTE_D) {
        return {
          asOf: "2026-03-13T00:00:01.000Z",
          nodes: [{ id: DERIVED_NOTE_D, kind: "document", label: "引用 S 的派生笔记 D" }],
          edges: [],
          page: { nextCursor: null },
          completeness: "complete",
          warnings: [],
          detail: {
            id: DERIVED_NOTE_D,
            learnerState: null,
            requirementStatus: null,
            notes: ["基于资料 S 整理的派生摘要"],
            actions: [],
          },
        };
      }

      if (query.op === "neighbors" && query.focus === SOURCE_S) {
        if (sourceDeleted) {
          throw new AssetGraphRequestError("NOT_FOUND", "请求的资源不可用。", 404);
        }
        return {
          asOf: "2026-03-13T00:00:02.000Z",
          nodes: [
            { id: SOURCE_S, kind: "source", label: "待删除资料 S" },
            { id: VISIBLE_REQ, kind: "requirement", label: "第3章 有机反应：酯化" },
          ],
          edges: [
            {
              id: neighborEdgeId,
              from: VISIBLE_REQ,
              to: SOURCE_S,
              relation: "usesSource",
              basis: "recorded",
            },
          ],
          page: { nextCursor: "source-s-neighbors-p2" },
          completeness: "complete",
          warnings: [],
          detail: null,
        };
      }

      throw new Error(`Unexpected query: ${JSON.stringify(query)}`);
    };

    // Part 1: Paginated neighbor request (with cursor) hits NOT_FOUND after S is deleted
    const store = createAssetGraphStore(createAssetGraphClient(transport), {
      lens: "assets",
      selectedKinds: ["source", "document"],
      searchQuery: "有机",
    });
    await store.initialize();
    await store.loadDetail(DERIVED_NOTE_D);
    store.togglePinNode(DERIVED_NOTE_D);
    await store.expandNode(SOURCE_S, "in");

    expect(store.getState().rootIds).toEqual([SOURCE_S, DERIVED_NOTE_D, VISIBLE_SOURCE]);
    expect(store.getState().pinnedComparison?.node.id).toBe(DERIVED_NOTE_D);
    expect(store.getState().expandedCenters[SOURCE_S]?.nextCursor).toBe("source-s-neighbors-p2");

    // Delete S on server -> D is also unreadable; loadMoreNeighbors(S) sends cursor and receives 404 NOT_FOUND
    sourceDeleted = true;
    deferNextRootsReload = true;
    const reloadStarted = new Promise<void>(resolve => {
      signalReloadStarted = resolve;
    });
    const pagedPromise = store.loadMoreNeighbors(SOURCE_S);

    await reloadStarted;

    // Immediately before reload resolves: S, D, edges, expandedCenters, pinnedComparison, and detail must already be wiped
    const midReload = store.getState();
    expect(midReload.nodesById).toEqual({});
    expect(midReload.edgesById).toEqual({});
    expect(midReload.rootIds).toEqual([]);
    expect(midReload.rootEdgeIds).toEqual([]);
    expect(midReload.expandedCenters).toEqual({});
    expect(midReload.pinnedComparison).toBeNull();
    expect(midReload.detail).toBeNull();
    expect(midReload.selectedNodeId).toBeNull();
    expect(midReload.notice).toBe(NOT_FOUND_SAFE_NOTICE);
    expect(midReload.loadingRoots).toBe(true);

    resolveDeferredReload!({
      asOf: "2026-03-13T00:05:00.000Z",
      nodes: [{ id: VISIBLE_SOURCE, kind: "source", label: "仍可见的有机化学参考书" }],
      edges: [],
      page: { nextCursor: null },
      completeness: "complete",
      warnings: [],
      detail: null,
    });
    const pagedResult = await pagedPromise;
    expect(pagedResult).toEqual({ applied: false, reason: "not_found" });

    const afterPaged = store.getState();
    expect(afterPaged.nodesById[SOURCE_S]).toBeUndefined();
    expect(afterPaged.nodesById[DERIVED_NOTE_D]).toBeUndefined();
    expect(afterPaged.nodesById[VISIBLE_REQ]).toBeUndefined();
    expect(afterPaged.rootIds).toEqual([VISIBLE_SOURCE]);
    expect(afterPaged.rootEdgeIds).toEqual([]);
    expect(afterPaged.edgesById).toEqual({});
    expect(afterPaged.expandedCenters).toEqual({});
    expect(afterPaged.pinnedComparison).toBeNull();
    expect(afterPaged.detail).toBeNull();
    expect(afterPaged.selectedNodeId).toBeNull();
    expect(afterPaged.notice).toBe(NOT_FOUND_SAFE_NOTICE);
    expect(afterPaged.error).toBeNull();
    expect(getVisibleNodes(afterPaged).map(n => n.id)).toEqual([VISIBLE_SOURCE]);
    expect(recordedRootsQueries.at(-1)).toMatchObject({
      op: "roots",
      lens: "assets",
      kinds: ["source", "document"],
      q: "有机",
    });
    expect((recordedRootsQueries.at(-1) as { cursor?: string }).cursor).toBeUndefined();

    // Part 2: Initial expandNode(S) (without cursor) hits NOT_FOUND -> also wipes S, D, pinnedComparison, detail and reloads
    sourceDeleted = false;
    const initialExpandStore = createAssetGraphStore(createAssetGraphClient(transport), {
      lens: "assets",
    });
    await initialExpandStore.initialize();
    await initialExpandStore.loadDetail(DERIVED_NOTE_D);
    initialExpandStore.togglePinNode(DERIVED_NOTE_D);

    expect(initialExpandStore.getState().rootIds).toContain(DERIVED_NOTE_D);
    expect(initialExpandStore.getState().pinnedComparison?.node.id).toBe(DERIVED_NOTE_D);
    expect(initialExpandStore.getState().detail?.id).toBe(DERIVED_NOTE_D);

    sourceDeleted = true;
    const initialResult = await initialExpandStore.expandNode(SOURCE_S, "in");
    expect(initialResult).toEqual({ applied: false, reason: "not_found" });

    const afterInitial = initialExpandStore.getState();
    expect(afterInitial.nodesById[SOURCE_S]).toBeUndefined();
    expect(afterInitial.nodesById[DERIVED_NOTE_D]).toBeUndefined();
    expect(afterInitial.rootIds).toEqual([VISIBLE_SOURCE]);
    expect(afterInitial.edgesById).toEqual({});
    expect(afterInitial.expandedCenters).toEqual({});
    expect(afterInitial.pinnedComparison).toBeNull();
    expect(afterInitial.detail).toBeNull();
    expect(afterInitial.notice).toBe(NOT_FOUND_SAFE_NOTICE);
    expect(afterInitial.error).toBeNull();

    // Part 3: If automatic roots reload also fails, stops safely in error state without looping or leaking S/D
    recordedRootsQueries.length = 0;
    sourceDeleted = false;
    const failReloadStore = createAssetGraphStore(createAssetGraphClient(transport), {
      lens: "assets",
    });
    await failReloadStore.initialize();
    failReloadStore.togglePinNode(DERIVED_NOTE_D);
    expect(recordedRootsQueries).toHaveLength(1);

    sourceDeleted = true;
    failReloadWith = new AssetGraphRequestError("CURSOR_STALE", "当前视图重读失败，请稍后重试。", 409);
    const failedReloadResult = await failReloadStore.expandNode(SOURCE_S, "in");
    expect(failedReloadResult).toEqual({ applied: false, reason: "not_found" });
    // Bounded: 1 initial roots + 1 automatic reload attempt (no CURSOR_STALE loop)
    expect(recordedRootsQueries).toHaveLength(2);

    const afterFailedReload = failReloadStore.getState();
    expect(afterFailedReload.nodesById).toEqual({});
    expect(afterFailedReload.edgesById).toEqual({});
    expect(afterFailedReload.rootIds).toEqual([]);
    expect(afterFailedReload.pinnedComparison).toBeNull();
    expect(afterFailedReload.detail).toBeNull();
    expect(afterFailedReload.lastFailedOperation).toEqual({ op: "roots" });
    expect(afterFailedReload.error).toEqual({
      code: "CURSOR_STALE",
      message: "当前视图重读失败，请稍后重试。",
    });

    // Recoverable via manual retryCurrentView once backend recovers
    failReloadWith = null;
    await failReloadStore.retryCurrentView();
    expect(recordedRootsQueries).toHaveLength(3);
    expect(failReloadStore.getState().error).toBeNull();
    expect(failReloadStore.getState().rootIds).toEqual([VISIBLE_SOURCE]);
  });
});
