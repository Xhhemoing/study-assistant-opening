// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const diagnosticPreference = vi.hoisted(() => ({ enabled: false }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => diagnosticPreference.enabled }));
beforeEach(() => { diagnosticPreference.enabled = false; });

vi.mock("./preference-controls", () => ({
  PreferenceControls: () => createElement("div", { "data-testid": "session-intervention-prefs" }),
}));

// The shared panel owns its dialog/mount lifecycle tests; inspect this workspace's wiring here.
vi.mock("./study-tools-panel", () => ({
  StudyToolsToggle: ({ activePanel, onPanelChange }: { activePanel: string | null; onPanelChange: (panel: string | null) => void }) => createElement("button", { onClick: () => onPanelChange(activePanel ? null : "chat") }, "工具"),
  StudyToolsPanel: ({ children, panels, showToolbar }: { children: ReactNode; showToolbar?: boolean; panels: { id: string; label: string; content: ReactNode; mountKey?: string }[] }) => createElement("div", { "data-tools-layout": "true" }, createElement("div", { hidden: true, role: "tablist" }, panels.map(panel => createElement("button", { key: panel.id, role: "tab" }, panel.label))),
    showToolbar === false ? null : createElement("nav", {}, panels.map(panel => createElement("button", { key: panel.id }, panel.label))), children,
    panels.filter((panel, index) => panels.findIndex(item => (item.mountKey ?? item.id) === (panel.mountKey ?? panel.id)) === index).map(panel => createElement("section", { key: panel.id, hidden: true, "data-panel": panel.id }, panel.content))),
}));

vi.mock("./block-commands", async () => {
  const actual = await vi.importActual<typeof import("./block-commands")>("./block-commands");
  return {
    ...actual,
    BlockCommands: (props: { blockId: string; returnDisabled: boolean }) =>
      createElement("div", {
        "data-testid": "block-commands-mock",
        "data-block-id": props.blockId,
        "data-return-disabled": String(props.returnDisabled),
      }),
  };
});

vi.mock("./resume-card", async () => {
  const actual = await vi.importActual<typeof import("./resume-card")>("./resume-card");
  return {
    ...actual,
    ResumeCard: (props: {
      activity: { id: string; intentSummary: string };
      resume?: { activityId: string; clientInit: unknown } | null;
      onContinue?: (resume: unknown) => void;
    }) =>
      createElement(
        "div",
        {
          "data-testid": "resume-card-mock",
          "data-activity-id": props.activity.id,
          "data-has-resume": props.resume ? "true" : "false",
        },
        createElement(
          "button",
          {
            type: "button",
            "data-resume-continue-cta": "true",
            onClick: () => props.onContinue?.(props.resume),
          },
          "继续学习",
        ),
      ),
  };
});

import type { ActivitySpecClientInit, LearningResume, TeachingActivity } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import {
  formatTeachingSourceLabel,
  isTeachingWorkspaceContentUsable,
  TeachingContinueEntry,
  TeachingWorkspace,
  waitInitActionVisibility,
  saveCurrentTeachingUnitPosition,
  type TeachingToolsContext,
  type TeachingWorkspacePositionSnapshot,
} from "./teaching-workspace";

const AID = "11111111-1111-4111-8111-111111111111";
const WID = "22222222-2222-4222-8222-222222222222";
const OID = "33333333-3333-4333-8333-333333333333";
const BID = "44444444-4444-4444-8444-444444444444";
const BID2 = "55555555-5555-4555-8555-555555555555";
const BID3 = "99999999-9999-4999-8999-999999999999";
const DOC = "66666666-6666-4666-8666-666666666666";
const UNIT = "77777777-7777-4777-8777-777777777777";
const SPEC = "88888888-8888-4888-8888-888888888888";
const ISO = "2026-10-11T04:00:00.000Z";

const activityReady: TeachingActivity = {
  id: AID,
  workspaceId: WID,
  ownerUserId: OID,
  courseId: null,
  status: "active",
  generateStatus: "ready",
  intentKind: "topic",
  intentSummary: "今日主题学习",
  sourceIds: [],
  pathVersion: 1,
  contentVersion: 1,
  clientKey: "today-topic:2026-10-11",
  createdAt: ISO,
  updatedAt: ISO,
};

it("stops automatic legacy returns when leaving a workspace with the first return in flight", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  let release!: (value: unknown) => void;
  const postTeachingCommand = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(TeachingWorkspace, {
      activity: activityReady, clientInit: clientInit({ checkpointJson: { currentBlockId: BID, branchStack: [{}, {}] } }),
      contextualTools: createElement("p", {}, "当前追问"), api: { postTeachingCommand } as unknown as OpeningApi,
    })));
    const tools = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "工具")!;
    await act(async () => tools().click());
    await act(async () => tools().click());
    expect(postTeachingCommand).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    await act(async () => release({ ok: true, activityId: AID, kind: "return", contentVersion: 1, pathVersion: 2,
      checkpointJson: { currentBlockId: BID, branchStack: [{}] }, replayed: false }));
    expect(postTeachingCommand).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("shows technical diagnostics only when the appearance preference is enabled", () => {
  const render = () => renderToStaticMarkup(createElement(TeachingWorkspace, { activity: activityReady, clientInit: clientInit(), sourceNameById: {} }));
  expect(render()).not.toContain("活动标识：");
  diagnosticPreference.enabled = true;
  expect(render()).toContain("活动标识：");
});

async function withNavigationWorkspace(api: Partial<OpeningApi>, checkpoint: Record<string, unknown>, run: (host: HTMLDivElement, leave: () => Promise<void>) => Promise<void>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(TeachingWorkspace, { activity: activityReady,
      clientInit: clientInit({ checkpointJson: checkpoint }), contextualTools: createElement("p", {}, "当前追问"), api: api as OpeningApi })));
    await run(host, async () => { await act(async () => root.render(null)); });
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
}
function navigateToQuestion(host: HTMLDivElement) {
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "2. 练习 2")!.click();
}
const currentUnitId = (host: HTMLDivElement) => host.querySelector('[data-study-unit-current="true"]')?.getAttribute("data-study-unit");

it("returns legacy branches before navigating once, then keeps the selected unit when tools close", async () => {
  let releaseReturn!: (value: unknown) => void;
  const postTeachingCommand = vi.fn(() => new Promise(resolve => { releaseReturn = resolve; }));
  const postTeachingCheckpoint = vi.fn(async () => ({ ok: true as const, contentVersion: 1, checkpointJson: { currentBlockId: BID2, branchStack: [] } }));
  await withNavigationWorkspace({ postTeachingCommand: postTeachingCommand as OpeningApi["postTeachingCommand"], postTeachingCheckpoint },
    { currentBlockId: BID, branchStack: [{ resumeBlockId: BID }] }, async host => {
      await act(async () => { navigateToQuestion(host); navigateToQuestion(host); });
      expect(postTeachingCommand).toHaveBeenCalledOnce();
      expect(postTeachingCheckpoint).not.toHaveBeenCalled();
      expect(currentUnitId(host)).toBe(BID);
      await act(async () => releaseReturn({ ok: true, kind: "return", contentVersion: 1, pathVersion: 2, checkpointJson: { currentBlockId: BID, branchStack: [] } }));
      expect(postTeachingCheckpoint).toHaveBeenCalledExactlyOnceWith(AID, { expectedVersion: 1, currentBlockId: BID2 });
      expect(currentUnitId(host)).toBe(BID2);
      expect(host.querySelector("[data-teaching-workspace]")?.getAttribute("data-path-version")).toBe("2");
      const tools = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "工具")!;
      await act(async () => tools().click());
      await act(async () => tools().click());
      expect(postTeachingCommand).toHaveBeenCalledOnce();
      expect(currentUnitId(host)).toBe(BID2);
    });
});

it.each(["conflict", "network"])("does not save the selected target after a legacy return %s", async failure => {
  const postTeachingCommand = vi.fn(async () => {
    if (failure === "network") throw new Error("回主线结果尚未确认");
    return { ok: false, conflict: "stale_path_version", message: "位置已变化" };
  });
  const postTeachingCheckpoint = vi.fn();
  await withNavigationWorkspace({ postTeachingCommand: postTeachingCommand as OpeningApi["postTeachingCommand"], postTeachingCheckpoint },
    { currentBlockId: BID, branchStack: [{ resumeBlockId: BID }] }, async host => {
      await act(async () => navigateToQuestion(host));
      expect(postTeachingCommand).toHaveBeenCalledOnce();
      expect(postTeachingCheckpoint).not.toHaveBeenCalled();
      expect(currentUnitId(host)).toBe(BID);
      if (failure === "network") expect(host.querySelector('[role="alert"] button')).not.toBeNull();
      else expect(host.querySelector('[data-workspace-command-conflict="stale_path_version"]')).not.toBeNull();
    });
});

it("passes each confirmed return version to the next return before saving the target", async () => {
  const postTeachingCommand = vi.fn().mockResolvedValueOnce({ ok: true, contentVersion: 1, pathVersion: 2, checkpointJson: { currentBlockId: BID, branchStack: [{}] } })
    .mockResolvedValueOnce({ ok: true, contentVersion: 1, pathVersion: 3, checkpointJson: { currentBlockId: BID, branchStack: [] } });
  const postTeachingCheckpoint = vi.fn(async () => ({ ok: true as const, contentVersion: 1, checkpointJson: { currentBlockId: BID2, branchStack: [] } }));
  await withNavigationWorkspace({ postTeachingCommand, postTeachingCheckpoint }, { currentBlockId: BID, branchStack: [{}, {}] }, async host => {
    await act(async () => navigateToQuestion(host));
    expect(postTeachingCommand.mock.calls.map(call => call[1].expectedPathVersion)).toEqual([1, 2]);
    expect(postTeachingCheckpoint).toHaveBeenCalledOnce();
    expect(currentUnitId(host)).toBe(BID2);
    expect(host.querySelector("[data-teaching-workspace]")?.getAttribute("data-path-version")).toBe("3");
  });
});

it("keeps ordinary navigation free of return commands", async () => {
  const postTeachingCommand = vi.fn();
  const postTeachingCheckpoint = vi.fn(async () => ({ ok: true as const, contentVersion: 1, checkpointJson: { currentBlockId: BID2, branchStack: [] } }));
  await withNavigationWorkspace({ postTeachingCommand, postTeachingCheckpoint }, { currentBlockId: BID, branchStack: [] }, async host => {
    await act(async () => navigateToQuestion(host));
    expect(postTeachingCommand).not.toHaveBeenCalled();
    expect(postTeachingCheckpoint).toHaveBeenCalledOnce();
    expect(currentUnitId(host)).toBe(BID2);
  });
});

it("keeps a partially confirmed return and retries only the remaining branch", async () => {
  const postTeachingCommand = vi.fn().mockResolvedValueOnce({ ok: true, contentVersion: 1, pathVersion: 2, checkpointJson: { currentBlockId: BID, branchStack: [{}] } })
    .mockResolvedValueOnce({ ok: false, conflict: "stale_path_version", message: "位置已变化" })
    .mockResolvedValueOnce({ ok: true, contentVersion: 1, pathVersion: 3, checkpointJson: { currentBlockId: BID, branchStack: [] } });
  const postTeachingCheckpoint = vi.fn(async () => ({ ok: true as const, contentVersion: 1, checkpointJson: { currentBlockId: BID2, branchStack: [] } }));
  await withNavigationWorkspace({ postTeachingCommand, postTeachingCheckpoint }, { currentBlockId: BID, branchStack: [{}, {}] }, async host => {
    await act(async () => navigateToQuestion(host));
    expect(postTeachingCheckpoint).not.toHaveBeenCalled();
    expect(currentUnitId(host)).toBe(BID);
    expect(host.querySelector("[data-teaching-workspace]")?.getAttribute("data-path-version")).toBe("2");
    await act(async () => navigateToQuestion(host));
    expect(postTeachingCommand.mock.calls.map(call => call[1].expectedPathVersion)).toEqual([1, 2, 2]);
    expect(postTeachingCheckpoint).toHaveBeenCalledOnce();
    expect(currentUnitId(host)).toBe(BID2);
  });
});

it("does not select the target if its checkpoint fails after a confirmed return", async () => {
  const postTeachingCommand = vi.fn().mockResolvedValue({ ok: true, contentVersion: 1, pathVersion: 2, checkpointJson: { currentBlockId: BID, branchStack: [] } });
  const postTeachingCheckpoint = vi.fn().mockRejectedValueOnce(new Error("位置保存未确认"))
    .mockResolvedValueOnce({ ok: true, contentVersion: 1, checkpointJson: { currentBlockId: BID2, branchStack: [] } });
  await withNavigationWorkspace({ postTeachingCommand, postTeachingCheckpoint }, { currentBlockId: BID, branchStack: [{}] }, async host => {
    await act(async () => navigateToQuestion(host));
    expect(currentUnitId(host)).toBe(BID);
    expect(host.querySelector('[role="alert"] button')).not.toBeNull();
    await act(async () => navigateToQuestion(host));
    expect(postTeachingCommand).toHaveBeenCalledOnce();
    expect(postTeachingCheckpoint).toHaveBeenCalledTimes(2);
    expect(currentUnitId(host)).toBe(BID2);
  });
});

it("does not save a navigation target after leaving during a legacy return", async () => {
  let release!: (value: unknown) => void;
  const postTeachingCommand = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const postTeachingCheckpoint = vi.fn();
  await withNavigationWorkspace({ postTeachingCommand: postTeachingCommand as OpeningApi["postTeachingCommand"], postTeachingCheckpoint },
    { currentBlockId: BID, branchStack: [{}, {}] }, async (host, leave) => {
      await act(async () => navigateToQuestion(host));
      await leave();
      await act(async () => release({ ok: true, contentVersion: 1, pathVersion: 2, checkpointJson: { currentBlockId: BID, branchStack: [{}] } }));
      expect(postTeachingCommand).toHaveBeenCalledOnce();
      expect(postTeachingCheckpoint).not.toHaveBeenCalled();
    });
});

describe("asynchronous teaching position updates", () => {
  const initial: TeachingWorkspacePositionSnapshot = { activityId: AID, contentVersion: 3, pathVersion: 2, epoch: 1 };
  it.each([
    { cause: "new content", changed: { contentVersion: 4 } },
    { cause: "a skip or branch command", changed: { pathVersion: 3 } },
    { cause: "another activity", changed: { activityId: WID } },
    { cause: "reread or parent refresh with the same versions", changed: { epoch: 2 } },
  ])("does not apply a delayed cursor response after $cause", async ({ changed }) => {
    type Result = { ok: true; contentVersion: number; checkpointJson: Record<string, unknown> };
    let release!: (result: Result) => void;
    const pending = new Promise<Result>(resolve => { release = resolve; });
    const postTeachingCheckpoint = vi.fn(() => pending);
    let latest = { ...initial };
    const apply = vi.fn();
    const saving = saveCurrentTeachingUnitPosition({ postTeachingCheckpoint }, { ...initial }, () => latest, BID2, apply);
    latest = { ...latest, ...changed };
    release({ ok: true, contentVersion: 3, checkpointJson: { currentBlockId: BID2, drafts: [{ blockId: BID, draftText: "旧快照" }] } });
    await expect(saving).rejects.toThrow("刚才的位置响应未采用");
    expect(apply).not.toHaveBeenCalled();
    expect(postTeachingCheckpoint).toHaveBeenCalledWith(AID, { expectedVersion: 3, currentBlockId: BID2 });
    expect(latest).toEqual({ ...initial, ...changed });
  });
  it("adopts an unchanged response once with the server's preserved checkpoint", async () => {
    const result = { ok: true as const, contentVersion: 3, checkpointJson: { currentBlockId: BID2, drafts: [{ blockId: BID, draftText: "保留原草稿" }] } };
    const postTeachingCheckpoint = vi.fn(async () => result);
    const apply = vi.fn();
    await saveCurrentTeachingUnitPosition({ postTeachingCheckpoint }, initial, () => initial, BID2, apply);
    expect(apply).toHaveBeenCalledExactlyOnceWith(result);
  });
});

function clientInit(overrides?: Partial<ActivitySpecClientInit>): ActivitySpecClientInit {
  return {
    id: SPEC,
    activityId: AID,
    teachingUnitId: UNIT,
    documentId: DOC,
    revisionNumber: 1,
    blockOrder: [
      { blockId: BID, position: 0, blockType: "text", role: "teach" },
      { blockId: BID2, position: 1, blockType: "question", role: "prompt" },
      { blockId: BID3, position: 2, blockType: "answer_key", role: "answer_key" },
    ],
    sourceRefs: [],
    goals: [{ goalId: "g1", statement: "理解矩阵秩" }],
    verificationStatus: "structure_ok",
    generationConfig: {},
    version: 1,
    createdAt: ISO,
    updatedAt: ISO,
    blocks: [
      {
        blockId: BID,
        position: 0,
        blockType: "text",
        role: "teach",
        content: { text: "矩阵的秩表示线性无关行的最大个数。" },
      },
      {
        blockId: BID2,
        position: 1,
        blockType: "question",
        role: "prompt",
        content: { text: "写出一个秩为 2 的 3×3 矩阵例子。" },
      },
      {
        blockId: BID3,
        position: 2,
        blockType: "answer_key",
        role: "answer_key",
        content: null,
        answerRef: { refId: BID3, revealState: "hidden" },
      },
    ],
    contentVersion: 1,
    checkpointJson: {},
    ...overrides,
  };
}

describe("isTeachingWorkspaceContentUsable", () => {
  it("admits ready or needs_check with non-empty blocks", () => {
    expect(isTeachingWorkspaceContentUsable(activityReady, clientInit())).toBe(true);
    const needsCheckActivity = { ...activityReady, generateStatus: "needs_check" as const };
    expect(isTeachingWorkspaceContentUsable(needsCheckActivity, clientInit())).toBe(true);
    expect(
      isTeachingWorkspaceContentUsable(needsCheckActivity, clientInit({ blocks: [] })),
    ).toBe(false);
    expect(
      isTeachingWorkspaceContentUsable(
        { ...activityReady, generateStatus: "failed" },
        clientInit(),
      ),
    ).toBe(false);
    expect(
      isTeachingWorkspaceContentUsable(
        { ...activityReady, generateStatus: "queued" },
        clientInit(),
      ),
    ).toBe(false);
    expect(isTeachingWorkspaceContentUsable(activityReady, null)).toBe(false);
    expect(
      isTeachingWorkspaceContentUsable(activityReady, clientInit({ blocks: [] })),
    ).toBe(false);
  });
});

describe("TeachingWorkspace", () => {
  it("focuses the complete current explanation and offers one main advance plus one auxiliary panel", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingWorkspace, {
        activity: activityReady,
        clientInit: clientInit(),
        assistantHref: "/opening/assistant?conversation=x",
      }),
    );
    expect(html).toContain("data-teaching-workspace=\"true\"");
    expect(html).toContain("本次学习");
    expect(html).toContain("矩阵的秩");
    // Future questions are not pre-mounted until visited or the whole lesson is requested.
    expect(html).toContain('data-teaching-block-focus="current"');
    expect(html).not.toContain('data-teaching-block-focus="upcoming"');
    expect(html).toContain(`data-current-block-id="${BID}"`);
    expect(html).toContain("进入练习");
    expect(html).not.toContain(`data-block-id="${BID2}"`);
    expect(html).not.toContain(`data-block-id="${BID3}"`);
    expect(html).not.toContain("data-teaching-past-collapsed");
    expect(html).toContain("目录");
    expect(html).toContain('data-panel="materials"');
    expect(html).not.toContain("自由探索");
    expect(html).not.toContain("学习设置");
    expect(html).toContain('aria-label="选择学习单元"');
    expect(html).not.toContain('data-panel="outline"');
    expect(html).toContain('data-testid="block-commands-mock"');
    expect(html).toContain(`data-block-id="${BID}"`);
    expect(html).toContain('data-return-disabled="true"');
    expect(html).toContain('data-content-version="1"');
    expect(html).toContain('data-path-version="1"');
    expect(html.match(/data-testid="block-commands-mock"/g)).toHaveLength(1);
    expect(html.match(/data-teaching-primary-advance="true"/g)).toHaveLength(1);
    expect(html).not.toContain("AssistantView");
    expect(html).not.toContain("MediaReader");
  });

  it("keeps the initial lesson within ten available controls and puts the outline in its title", () => {
    const html = renderToStaticMarkup(createElement(TeachingWorkspace, {
      activity: activityReady, clientInit: clientInit(),
      headerLeading: createElement("a", { href: "/opening/courses/course" }, "返回课程"),
    }));
    const parsed = document.createElement("div"); parsed.innerHTML = html;
    const available = [...parsed.querySelectorAll("button,a[href],input,textarea,select,summary")].filter(control => {
      if (control.hasAttribute("disabled") || control.closest("[hidden]")) return false;
      for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === "DETAILS" && !ancestor.hasAttribute("open")) {
          const summary = ancestor.querySelector(":scope > summary");
          if (control !== summary && !summary?.contains(control)) return false;
        }
      }
      return true;
    });
    expect(available.length).toBeLessThanOrEqual(10);
    expect(parsed.querySelector('header [aria-label="选择学习单元"]')).not.toBeNull();
    expect(available.filter(control => control.tagName === "BUTTON" && control.closest("header")).length).toBe(2);
    expect(html).not.toContain("session-intervention-prefs");
    expect(html).not.toContain("其他学习方式");
  });
  it("restores the actual question unit and keeps earlier context available through the outline", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingWorkspace, {
        activity: activityReady,
        clientInit: clientInit({
          checkpointJson: {
            currentBlockId: BID2,
            skippedBlockIds: [BID],
          },
        }),
      }),
    );
    expect(html).toContain(`data-current-block-id="${BID2}"`);
    expect(html).toContain('data-teaching-block-focus="current"');
    expect(html).toContain(`data-block-id="${BID2}"`);
    expect(html).toContain(`data-study-unit="${BID2}"`);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("目录");
    expect(html).not.toContain("矩阵的秩表示线性无关行的最大个数。");
    expect(html).not.toContain('data-teaching-block-focus="skipped"');
    expect(html).not.toContain(`data-block-id="${BID3}"`);
    expect(html).toContain("试一试");
    expect(html).not.toContain("data-block-fail-soft=\"answer_hidden\"");
    expect(html).not.toContain('data-teaching-primary-advance="true"');
  });

  it("uses the same unit position for the heading and accessible progress after content changes", () => {
    const initial = clientInit();
    const html = renderToStaticMarkup(createElement(TeachingWorkspace, {
      activity: activityReady,
      clientInit: { ...initial, contentVersion: initial.contentVersion + 1, checkpointJson: { currentBlockId: BID2 } },
    }));
    expect(html).toContain("单元 2 / 2");
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuemax="2"[^>]*aria-valuenow="2"/);
    const empty = renderToStaticMarkup(createElement(TeachingWorkspace, { activity: activityReady, clientInit: clientInit({ blocks: [] }) }));
    expect(empty).not.toContain("单元 1 / 0");
    expect(empty).not.toContain('role="progressbar"');
  });
  it("shows material title not bare UUID as the sole source label", () => {
    const sourceId = "6a80b8ed-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const html = renderToStaticMarkup(
      createElement(TeachingWorkspace, {
        activity: { ...activityReady, sourceIds: [sourceId] },
        clientInit: clientInit({
          sourceRefs: [{ sourceId, version: 1, page: 2 }],
        }),
        sourceNameById: { [sourceId]: "gaoshu-limits.md" },
      }),
    );
    expect(html).toContain("gaoshu-limits.md");
    expect(html).toContain('data-source-ref="' + sourceId + '"');
    // Full UUID must not be the sole visible label (title is primary).
    expect(html).not.toMatch(new RegExp(`data-source-ref="${sourceId}"[^>]*>\\s*<span[^>]*>来源</span>`));
    expect(html).not.toContain(`>${sourceId}<`);
  });

  it("formatTeachingSourceLabel never returns bare UUID as primary", () => {
    const sourceId = "6a80b8ed-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const named = formatTeachingSourceLabel({ sourceId }, { [sourceId]: "极限讲义.md" });
    expect(named.primary).toBe("极限讲义.md");
    expect(named.secondary).toContain("6a80b8ed");
    const unnamed = formatTeachingSourceLabel({ sourceId });
    expect(unnamed.primary).toBe("未命名材料");
    expect(unnamed.primary).not.toBe(sourceId);
  });

  it("shows 待核对 status when generateStatus is needs_check", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingWorkspace, {
        activity: { ...activityReady, generateStatus: "needs_check" },
        clientInit: clientInit(),
      }),
    );
    expect(html).toContain('data-teaching-needs-check="true"');
    expect(html).toContain("这节内容还在核对引用，可以先学");
    expect(html).toContain('role="note"');
    expect(html).not.toContain("需要核查");
  });

  it("non-workspace continue entry without needs_check omits 待核对 marker", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingContinueEntry, {
        activity: { ...activityReady, generateStatus: "queued", contentVersion: 0 },
        resume: null,
        startInWorkspace: false,
      }),
    );
    expect(html).not.toContain('data-teaching-needs-check="true"');
    expect(html).not.toContain("主讲内容待核对");
  });

  it("enables return when checkpoint branchStack non-empty", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingWorkspace, {
        activity: activityReady,
        clientInit: clientInit({
          checkpointJson: {
            branchStack: [
              {
                frameId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                fromBlockId: BID,
                contentVersion: 1,
                pathVersion: 1,
                createdAt: ISO,
              },
            ],
          },
        }),
      }),
    );
    expect(html).toContain('data-return-disabled="false"');
  });

  it("fail-soft banner on unknown schema version without crashing (C4)", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingWorkspace, {
        activity: activityReady,
        clientInit: clientInit({
          generationConfig: { extras: { schemaVersion: "999" } },
        }),
      }),
    );
    expect(html).toContain("data-workspace-schema-fail=\"true\"");
    expect(html).toContain("这节内容暂时打不开");
    expect(html).not.toContain("schema 版本不受支持");
  });

  it("binds contextual tools to the actual restored question and excludes its hidden answer", () => {
    const contextTools = vi.fn((context: TeachingToolsContext) => createElement("div", { "data-bound-context": context.blockId }, context.unitText));
    const html = renderToStaticMarkup(createElement(TeachingWorkspace, {
      activity: { ...activityReady, courseId: WID, pathVersion: 2 },
      clientInit: clientInit({ checkpointJson: { currentBlockId: BID2 }, contentVersion: 3 }),
      contextualTools: contextTools,
    }));
    expect(contextTools).toHaveBeenCalledWith(expect.objectContaining({
      activity: expect.objectContaining({ id: AID, courseId: WID, contentVersion: 3, pathVersion: 2 }),
      blockId: BID2, contentVersion: 3, isQuestion: true, learningAttempt: null,
      unitText: "写出一个秩为 2 的 3×3 矩阵例子。", sourceRefs: [],
    }));
    expect(html).toContain("对话");
    expect(html).toContain("笔记");
    expect(html).toContain('data-study-question="true"');
    expect(html).not.toContain("data-teaching-primary-advance=\"true\"");
  });
});

function learningResume(overrides?: Partial<LearningResume>): LearningResume {
  return {
    activityId: AID,
    status: "active",
    generateStatus: "ready",
    contentVersion: 1,
    pathVersion: 1,
    clientInit: clientInit(),
    thoughtTrain: {
      currentBlockId: BID,
      skippedBlockIds: [],
      branchStack: [],
      commandLog: [],
    },
    drafts: [],
    interactionParams: {},
    actualAttempts: [],
    helpDelivered: [],
    openProblems: [],
    gates: {
      permission: "owned",
      materials: "available",
      unavailableSourceIds: [],
      job: "ready",
    },
    continuableActions: ["continue_block"],
    summary: { status: "skipped" },
    ...overrides,
  };
}

describe("TeachingContinueEntry", () => {
  it("workspace admits needs_check via continue entry and shows 待核对", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingContinueEntry, {
        activity: { ...activityReady, generateStatus: "needs_check" },
        resume: learningResume({ generateStatus: "needs_check" }),
        startInWorkspace: true,
        initialClientInit: clientInit(),
      }),
    );
    expect(html).toContain('data-teaching-continue-entry="workspace"');
    expect(html).toContain('data-teaching-needs-check="true"');
    expect(html).toContain("这节内容还在核对引用，可以先学");
  });

  it("starts on resume-card (not ConversationResume)", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingContinueEntry, {
        activity: activityReady,
        resume: learningResume({ clientInit: null }),
      }),
    );
    expect(html).toContain('data-teaching-continue-entry="card"');
    expect(html).toContain('data-testid="resume-card-mock"');
    expect(html).not.toContain("ConversationResume");
    expect(html).not.toContain("data-teaching-workspace");
  });

  it("can open workspace immediately when startInWorkspace + usable init", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingContinueEntry, {
        activity: activityReady,
        resume: learningResume(),
        startInWorkspace: true,
        initialClientInit: clientInit(),
      }),
    );
    expect(html).toContain('data-teaching-continue-entry="workspace"');
    expect(html).toContain('data-teaching-workspace="true"');
    expect(html).toContain('data-testid="block-commands-mock"');
    expect(html).not.toContain("学习设置");
  });

  it("preserves V2-10/11/12 chrome when in workspace phase", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingContinueEntry, {
        activity: activityReady,
        startInWorkspace: true,
        initialClientInit: clientInit({
          checkpointJson: {
            branchStack: [
              {
                frameId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                fromBlockId: BID,
                contentVersion: 1,
                pathVersion: 1,
                createdAt: ISO,
              },
            ],
          },
        }),
      }),
    );
    expect(html).toContain('data-return-disabled="false"');
    expect(html).toContain('aria-label="选择学习单元"');
    expect(html).not.toContain('data-panel="outline"');
    expect(html).not.toContain("自由探索");
  });
});

describe("waitInitActionVisibility (S6)", () => {
  it("offers compile (not endless client-init retry) when nothing is in flight", () => {
    const actions = waitInitActionVisibility({ jobGate: "unknown", canCompile: true });
    expect(actions.showCompile).toBe(true);
    expect(actions.showRetryFetch).toBe(false);
    expect(actions.showBack).toBe(true);
  });

  it("keeps client-init retry while job is in_flight", () => {
    const actions = waitInitActionVisibility({ jobGate: "in_flight", canCompile: false });
    expect(actions.showRetryFetch).toBe(true);
    expect(actions.showCompile).toBe(false);
  });
});


it("keeps the question's next action inside its result stage rather than exposing a competing unit advance", () => {
  const nextBlockId = "88888888-8888-4888-8888-888888888888";
  const initial = clientInit();
  const html = renderToStaticMarkup(createElement(TeachingWorkspace, {
    activity: activityReady,
    clientInit: { ...initial, checkpointJson: { currentBlockId: BID2 }, blocks: [...initial.blocks, {
      blockId: nextBlockId, position: 3, blockType: "text", role: "teach", content: { text: "下一知识单元" },
    }] },
  }));
  expect(html).not.toContain("data-teaching-primary-advance");
  expect(html).toContain('data-attempt-stage="draft"');
  expect(html).toContain("目录");
});
