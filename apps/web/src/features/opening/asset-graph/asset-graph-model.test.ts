import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssetGraphPage, AssetGraphQuery } from "@aistudy/contracts";
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
  collectGraphWarnings,
  createAssetGraphStore,
  getVisibleEdges,
  getVisibleNodes,
  isGraphPartial,
} from "./asset-graph-model";

const fixturesPath = resolve(
  __dirname,
  "../../../../../../docs/brainstorm/2026-11-18-knowledge-assets-examples.json",
);
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as SyntheticAssetGraphFixtures;

const GOAL_ID = "goal/20000000-0000-4000-8000-000000000001" as const;
const REQ_ID = "requirement/30000000-0000-4000-8000-000000000001" as const;
const SOURCE_1_ID = "source/40000000-0000-4000-8000-000000000001" as const;
const SOURCE_2_ID = "source/40000000-0000-4000-8000-000000000002" as const;
const OBS_ID = "observation/50000000-0000-4000-8000-000000000001" as const;
const DOC_ID = "document/60000000-0000-4000-8000-000000000001" as const;
const EXP_ID = "exploration/70000000-0000-4000-8000-000000000001" as const;

describe("asset graph status labels", () => {
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
      searchQuery: "合成：从自由探索整理的个人笔记",
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

  it("handles 409 CURSOR_STALE by clearing graph state, bumping generation, and restarting from page 1", async () => {
    const baseTransport = createSyntheticAssetGraphTransport(fixtures);
    let injectedStaleOnce = false;
    const staleCursorTransport: AssetGraphTransport = async (query, signal) => {
      if (query.op === "roots" && query.cursor === "synthetic-source-roots-page-2-v1" && !injectedStaleOnce) {
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
  });

  it("evicts invalid focus node, adjacent edges, and center expansion on 404 NOT_FOUND", async () => {
    const store = createAssetGraphStore(
      createAssetGraphClient(createSyntheticAssetGraphTransport(fixtures)),
      { lens: "assets" },
    );

    await store.applyFilters({
      selectedKinds: ["document"],
      searchQuery: "合成：从自由探索整理的个人笔记",
    });
    await store.expandNode(DOC_ID, "in");
    expect(getVisibleNodes(store.getState()).map(n => n.id)).toEqual([DOC_ID, EXP_ID]);
    expect(getVisibleEdges(store.getState())).toHaveLength(1);

    // Simulate 404 NOT_FOUND arriving in goal context or after eviction
    const evictedState = applyNotFoundForFocus(store.getState(), DOC_ID);
    expect(evictedState.nodesById[DOC_ID]).toBeUndefined();
    expect(evictedState.nodesById[EXP_ID]).toBeDefined();
    expect(evictedState.rootIds).toEqual([]);
    expect(evictedState.expandedCenters[DOC_ID]).toBeUndefined();
    expect(getVisibleEdges(evictedState)).toHaveLength(0);
    expect(evictedState.selectedNodeId).toBeNull();
    expect(evictedState.notice).toBe(NOT_FOUND_SAFE_NOTICE);

    // Also test live 404 detail query in goal context (Case 19)
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
    // Immediately switch lens while first request is still pending
    await store.selectLens("assets");
    expect(store.getState().rootIds).toEqual([DOC_ID]);
    expect(store.getState().nodesById[DOC_ID]?.label).toBe("最新视角结果");

    // Now the stale first request resolves with an older node
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

    // Stale response must be completely discarded
    expect(store.getState().rootIds).toEqual([DOC_ID]);
    expect(store.getState().nodesById[GOAL_ID]).toBeUndefined();
  });

  it("flags partial completeness and collects warnings, and clears private view on 401/403", async () => {
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
});
