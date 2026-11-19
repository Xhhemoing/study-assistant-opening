// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WritingWorkspaceView } from "@aistudy/contracts";
import { WritingVariantsPanel } from "./writing-variants-panel";
import { createWritingWorkspaceApi, type WritingWorkspaceApi } from "./writing-workspace-api";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const BLOCK_1 = "33333333-3333-4333-8333-333333333333";
const BLOCK_2 = "44444444-4444-4444-8444-444444444444";
const ACTIVITY_ID = "55555555-5555-4555-8555-555555555555";
const ASSISTANCE_ID = "66666666-6666-4666-8666-666666666666";

function makeWorkspace(overrides: Partial<WritingWorkspaceView> = {}): WritingWorkspaceView {
  return {
    workGroupId: DOC_A,
    activityId: ACTIVITY_ID,
    courseId: null,
    currentDocumentId: DOC_B,
    currentVariant: {
      workGroupId: DOC_A,
      variantLabel: "B 稿",
      parentDocumentId: DOC_A,
      parentRevisionNumber: 1,
      keptAsPreferred: false,
      focusBlockId: BLOCK_2,
      assistanceRecords: [
        {
          id: ASSISTANCE_ID,
          documentId: DOC_B,
          baseRevisionNumber: 1,
          targetBlockId: BLOCK_1,
          targetBlockTextSnapshot: "原始句。",
          dimension: "language",
          kind: "polish_suggestion",
          suggestionText: "更凝练的润色句。",
          adoptedAt: null,
          adoptedRevisionNumber: null,
          createdAt: "2026-11-18T10:00:00.000Z",
        },
      ],
    },
    variants: [
      {
        documentId: DOC_A,
        title: "无课写作练习",
        variantLabel: "初稿",
        currentRevisionNumber: 1,
        parentDocumentId: null,
        parentRevisionNumber: null,
        keptAsPreferred: true,
        focusBlockId: BLOCK_1,
        assistanceCount: 0,
        adoptedPolishCount: 0,
        updatedAt: "2026-11-18T09:00:00.000Z",
      },
      {
        documentId: DOC_B,
        title: "无课写作练习",
        variantLabel: "B 稿",
        currentRevisionNumber: 1,
        parentDocumentId: DOC_A,
        parentRevisionNumber: 1,
        keptAsPreferred: false,
        focusBlockId: BLOCK_2,
        assistanceCount: 1,
        adoptedPolishCount: 0,
        updatedAt: "2026-11-18T10:00:00.000Z",
      },
    ],
    focusRestore: {
      status: "block_missing",
      requestedBlockId: BLOCK_2,
      message: "上次定位的段落已删除或合并，已打开当前服务器保存的内容。",
    },
    ...overrides,
  };
}

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mountPanel(props: Parameters<typeof WritingVariantsPanel>[0]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(createElement(WritingVariantsPanel, props));
  });
  return host;
}

describe("WritingVariantsPanel & writingWorkspaceApi", () => {
  it("renders uninitialized notes cleanly and allows deriving a new variant", async () => {
    const start = vi.fn();
    const get = vi.fn().mockResolvedValue({ initialized: false, documentId: DOC_A });
    const command = vi.fn().mockResolvedValue({
      workspace: makeWorkspace({ currentDocumentId: DOC_B }),
    });
    const api: WritingWorkspaceApi = { start, get, command };

    const host = await mountPanel({
      documentId: DOC_A,
      currentRevisionNumber: 1,
      blocks: [{ id: BLOCK_1, text: "首段内容" }],
      api,
    });

    expect(host.textContent).toContain("多稿对比与润色");
    expect(host.textContent).toContain("初稿");
    expect(host.textContent).toContain("A 稿");
    expect(host.textContent).toContain("B 稿");
    expect(host.textContent).toContain("已记录辅助，不计入独立作答成绩");

    const deriveButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "派生新稿")!;
    await act(async () => {
      deriveButton.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(command).toHaveBeenCalledWith(DOC_A, {
      action: "derive_variant",
      expectedRevisionNumber: 1,
      variantLabel: "A 稿",
      focusBlockId: BLOCK_1,
    });
    expect(host.textContent).toContain("打开B 稿");
  });

  it("surfaces block_missing banner, dimensions, preferred draft toggle, and adopts polish with refresh", async () => {
    const workspace = makeWorkspace();
    const adoptedWorkspace = makeWorkspace({
      currentVariant: {
        ...workspace.currentVariant,
        keptAsPreferred: false,
        assistanceRecords: [
          {
            ...workspace.currentVariant.assistanceRecords[0]!,
            adoptedAt: "2026-11-18T10:05:00.000Z",
            adoptedRevisionNumber: 2,
          },
        ],
      },
    });
    const get = vi.fn().mockResolvedValue({ initialized: true, workspace });
    const command = vi
      .fn()
      .mockResolvedValueOnce({
        workspace: adoptedWorkspace,
        outcome: {
          activityId: ACTIVITY_ID,
          courseId: null,
          documentId: DOC_B,
          revisionNumber: 2,
          assistance: "revealed",
          adoptedPolishCount: 1,
          keptAsPreferred: false,
          evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
        },
      })
      .mockResolvedValueOnce({
        workspace: makeWorkspace({
          currentVariant: { ...adoptedWorkspace.currentVariant, keptAsPreferred: true },
        }),
      });
    const onDocumentUpdated = vi.fn();

    const host = await mountPanel({
      documentId: DOC_B,
      currentRevisionNumber: 1,
      blocks: [{ id: BLOCK_1, text: "原始句。" }],
      activityId: ACTIVITY_ID,
      api: { start: vi.fn(), get, command },
      onDocumentUpdated,
    });

    expect(host.textContent).toContain("上次定位的段落已删除或合并，已打开当前服务器保存的内容。");
    expect(host.textContent).toContain("本周保留稿");
    for (const dim of ["论点", "语言", "结构", "论据"]) {
      expect(host.textContent).toContain(dim);
    }
    expect(host.textContent).toContain("已记录辅助，不计入独立作答成绩");

    const adoptBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "采纳此句润色")!;
    await act(async () => {
      adoptBtn.click();
    });
    expect(command).toHaveBeenCalledWith(DOC_B, {
      action: "adopt_suggestion",
      expectedRevisionNumber: 1,
      assistanceId: ASSISTANCE_ID,
      targetBlockId: BLOCK_1,
      replacementText: "更凝练的润色句。",
      activityId: ACTIVITY_ID,
    });
    expect(onDocumentUpdated).toHaveBeenCalledWith(2);

    const preferBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("标为本周保留稿"),
    )!;
    await act(async () => {
      preferBtn.click();
    });
    expect(command).toHaveBeenLastCalledWith(DOC_B, {
      action: "set_preferred_variant",
      keptAsPreferred: true,
      activityId: ACTIVITY_ID,
    });
    expect(onDocumentUpdated).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("已标记为本周保留稿");
  });

  it("decouples save_checkpoint and set_preferred_variant buttons, preserves unsaved edits and focus, and protects against 404 errors", async () => {
    const workspace = makeWorkspace({
      currentVariant: {
        ...makeWorkspace().currentVariant,
        keptAsPreferred: false,
        focusBlockId: BLOCK_1,
      },
      focusRestore: { status: "exact", blockId: BLOCK_1 },
    });
    const starredWorkspace = makeWorkspace({
      currentVariant: {
        ...workspace.currentVariant,
        keptAsPreferred: true,
      },
      variants: workspace.variants.map((v) => ({
        ...v,
        keptAsPreferred: v.documentId === DOC_B,
      })),
      focusRestore: { status: "exact", blockId: BLOCK_1 },
    });
    const checkpointedWorkspace = makeWorkspace({
      currentVariant: {
        ...starredWorkspace.currentVariant,
        focusBlockId: BLOCK_2,
      },
      variants: starredWorkspace.variants.map((v) =>
        v.documentId === DOC_B ? { ...v, focusBlockId: BLOCK_2 } : v,
      ),
      focusRestore: { status: "exact", blockId: BLOCK_2 },
    });

    const { WritingWorkspaceApiError } = await import("./writing-workspace-api");
    const get = vi.fn().mockResolvedValue({ initialized: true, workspace });
    const command = vi
      .fn()
      .mockResolvedValueOnce({ workspace: starredWorkspace })
      .mockResolvedValueOnce({ workspace: checkpointedWorkspace })
      .mockRejectedValueOnce(new WritingWorkspaceApiError("NOT_FOUND", "笔记不存在或不可用。", 404));
    const onDocumentUpdated = vi.fn();
    const onWorkspaceLoaded = vi.fn();

    const host = await mountPanel({
      documentId: DOC_B,
      currentRevisionNumber: 1,
      blocks: [
        { id: BLOCK_1, text: "第一段内容" },
        { id: BLOCK_2, text: "第二段内容" },
      ],
      activityId: ACTIVITY_ID,
      hasUnsavedEdits: true,
      api: { start: vi.fn(), get, command },
      onDocumentUpdated,
      onWorkspaceLoaded,
    });

    // Change focus select to BLOCK_2 and type into suggestion textarea to verify neither is clobbered
    const focusSelect = host.querySelector('select[aria-label="选择续写段落"]') as HTMLSelectElement;
    await act(async () => {
      focusSelect.value = BLOCK_2;
      focusSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(focusSelect.value).toBe(BLOCK_2);

    // Clicking star button sends ONLY set_preferred_variant (no focusBlockId), even with hasUnsavedEdits=true
    const starBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("标为本周保留稿"),
    )!;
    expect(starBtn.disabled).toBe(false);
    await act(async () => {
      starBtn.click();
    });
    expect(command).toHaveBeenNthCalledWith(1, DOC_B, {
      action: "set_preferred_variant",
      keptAsPreferred: true,
      activityId: ACTIVITY_ID,
    });
    expect(host.textContent).toContain("已标记为本周保留稿");
    expect(host.textContent).toContain("已标为本周保留稿");
    expect(focusSelect.value).toBe(BLOCK_2);
    expect(onDocumentUpdated).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);

    // Clicking checkpoint button sends ONLY save_checkpoint (no keptAsPreferred)
    const checkpointBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "设为下次续写段落",
    )!;
    await act(async () => {
      checkpointBtn.click();
    });
    expect(command).toHaveBeenNthCalledWith(2, DOC_B, {
      action: "save_checkpoint",
      focusBlockId: BLOCK_2,
      activityId: ACTIVITY_ID,
    });
    expect(host.textContent).toContain("已保存续写段落位置");
    expect(onDocumentUpdated).not.toHaveBeenCalled();

    // Clicking star button again to unstar when server returns 404:
    // shows error alert, does NOT report success, preserves preferred state & focus selection
    const unstarBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("已标为本周保留稿"),
    )!;
    await act(async () => {
      unstarBtn.click();
    });
    expect(command).toHaveBeenNthCalledWith(3, DOC_B, {
      action: "set_preferred_variant",
      keptAsPreferred: false,
      activityId: ACTIVITY_ID,
    });
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("笔记不存在或不可用。");
    expect(host.textContent).not.toContain("已取消本周保留稿标记");
    expect(host.textContent).toContain("已标为本周保留稿");
    expect(focusSelect.value).toBe(BLOCK_2);
    expect(onDocumentUpdated).not.toHaveBeenCalled();
  });

  it("createWritingWorkspaceApi sends expected HTTP requests and validates responses", async () => {
    const workspace = makeWorkspace({ currentDocumentId: DOC_A });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(workspace, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ initialized: true, workspace }, { status: 200 }));
    const api = createWritingWorkspaceApi(fetchMock as unknown as typeof fetch);

    await expect(
      api.start({ clientKey: "writing-api-key", title: "测试题" }),
    ).resolves.toEqual(workspace);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/opening/writing",
      expect.objectContaining({ method: "POST" }),
    );

    await expect(
      api.get(DOC_A, { focusBlockId: BLOCK_1, activityId: ACTIVITY_ID }),
    ).resolves.toEqual({ initialized: true, workspace });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/opening/writing/${DOC_A}?focusBlock=${BLOCK_1}&activity=${ACTIVITY_ID}`,
      expect.objectContaining({ method: "GET" }),
    );
  });
});
