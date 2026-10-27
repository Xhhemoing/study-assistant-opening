// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TeachingCommandResponse, TeachingCommandSuccess } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import {
  BlockCommands,
  BlockCommandsBarView,
  SKIP_HONESTY_COPY,
  TEACHING_COMMAND_KINDS,
  branchStackDepth,
  conflictRequiresReread,
  isBranchStackEmpty,
  newTeachingCommandClientKey,
  teachingCommandConflictLabel,
  teachingCommandKindLabel,
} from "./block-commands";

const BID = "44444444-4444-4444-8444-444444444444";

function whyResult(contentVersion: number, summary: string): TeachingCommandSuccess {
  return { ok: true, kind: "why", activityId: BID, contentVersion, pathVersion: 1, checkpointJson: {}, replayed: false, assist: { kind: "why", summary } };
}

describe("BlockCommands explanation provenance", () => {
  it("drops a v1 explanation when stale content is reread as v2 without remounting the toolbar", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    const api = { postTeachingCommand: vi.fn().mockResolvedValueOnce(whyResult(1, "旧版的实际解释"))
      .mockResolvedValueOnce({ ok: false, conflict: "stale_content_version", message: "教学内容已更新", currentContentVersion: 2 })
      .mockResolvedValueOnce(whyResult(2, "新版的实际解释")) };
    const ask = vi.fn();
    function render(version: number) { root.render(createElement(BlockCommands, {
      activityId: BID, blockId: BID, contentVersion: version, returnDisabled: false, whyAvailable: true,
      api: api as unknown as OpeningApi, explanationContext: { activityId: BID, blockId: BID, contentVersion: version },
      onAskExplanation: ask, onReread: () => render(2),
    })); }
    const why = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "讲细点")!;
    try {
      await act(async () => render(1)); const originalButton = why();
      await act(async () => why().click()); expect(host.textContent).toContain("旧版的实际解释");
      await act(async () => why().click()); expect(host.textContent).not.toContain("旧版的实际解释");
      await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("重新读取教学内容"))!.click());
      expect(why()).toBe(originalButton); expect(host.querySelector("[data-anchor]")).toBeNull();
      await act(async () => why().click());
      expect(host.textContent).toContain("新版的实际解释"); expect(host.textContent).not.toContain("旧版的实际解释");
      await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "继续问")!.click());
      expect(ask).toHaveBeenCalledExactlyOnceWith("新版的实际解释");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("ignores a late v1 response and leaves the current v2 request pending until its own result", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    let first!: (value: TeachingCommandResponse) => void, second!: (value: TeachingCommandResponse) => void;
    const oldRequest = new Promise<TeachingCommandResponse>(resolve => { first = resolve; });
    const newRequest = new Promise<TeachingCommandResponse>(resolve => { second = resolve; });
    const api = { postTeachingCommand: vi.fn().mockReturnValueOnce(oldRequest).mockReturnValueOnce(newRequest) };
    const success = vi.fn();
    const render = (version: number) => root.render(createElement(BlockCommands, {
      activityId: BID, blockId: BID, contentVersion: version, returnDisabled: false, whyAvailable: true,
      api: api as unknown as OpeningApi, onSuccess: success,
      explanationContext: { activityId: BID, blockId: BID, contentVersion: version }, onAskExplanation() {},
    }));
    const why = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "讲细点")!;
    try {
      await act(async () => render(1)); await act(async () => why().click());
      await act(async () => render(2)); await act(async () => why().click());
      await act(async () => first(whyResult(1, "迟到的旧版解释")));
      expect(success).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("迟到的旧版解释");
      expect(why().disabled).toBe(true); expect(host.querySelector("[data-anchor]")).toBeNull();
      await act(async () => second(whyResult(2, "当前请求的解释")));
      expect(host.textContent).toContain("当前请求的解释"); expect(why().disabled).toBe(false);
      expect(success).toHaveBeenCalledExactlyOnceWith(whyResult(2, "当前请求的解释"));
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});

describe("branch stack helpers", () => {
  it("reads depth and empty from checkpoint", () => {
    expect(branchStackDepth(undefined)).toBe(0);
    expect(isBranchStackEmpty({})).toBe(true);
    expect(
      branchStackDepth({
        branchStack: [{ frameId: "x" }, { frameId: "y" }],
      }),
    ).toBe(2);
    expect(isBranchStackEmpty({ branchStack: [{ frameId: "x" }] })).toBe(false);
  });
});

describe("command labels / conflict policy", () => {
  it("covers all 7 kinds", () => {
    expect(TEACHING_COMMAND_KINDS).toHaveLength(7);
    for (const kind of TEACHING_COMMAND_KINDS) {
      expect(teachingCommandKindLabel(kind).length).toBeGreaterThan(0);
    }
  });

  it("requires reread for CAS / generate conflicts; never documents LWW", () => {
    expect(conflictRequiresReread("stale_content_version")).toBe(true);
    expect(conflictRequiresReread("generate_in_flight")).toBe(true);
    expect(conflictRequiresReread("branch_stack_empty")).toBe(false);
    expect(teachingCommandConflictLabel("stale_content_version")).toMatch(/重新读取/);
    expect(SKIP_HONESTY_COPY).toMatch(/不会记为答错/);
  });

  it("mint clientKey length >= 8", () => {
    expect(newTeachingCommandClientKey().length).toBeGreaterThanOrEqual(8);
  });
});

describe("BlockCommandsBarView", () => {
  it("offers direct note and editable card actions on the actual delivered explanation", () => {
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: false, whyAvailable: true,
      assist: { kind: "why", summary: "先比较两组向量的方向。" },
      explanationContext: { activityId: BID, contentVersion: 2 }, onAskExplanation() {}, onCommand() {},
    }));
    expect(html).toContain(`data-anchor="${BID}"`);
    expect(html).toContain("先比较两组向量的方向。");
    for (const action of ["保存", "制成卡片", "继续问"]) expect(html).toContain(action);
  });
  it("keeps a confused acknowledgement separate from an actual supplemental explanation", () => {
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: false, assist: { kind: "confused", summary: "已记下这里需要讲清楚。" },
      explanationContext: { activityId: BID, contentVersion: 2 }, onAskExplanation() {}, onCommand() {},
    }));
    expect(html).toContain("已记下这里需要讲清楚。");
    expect(html).not.toContain("保存");
  });
  it("offers the same four explanation actions without branch or skip controls", () => {
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: false, onAskExplanation() {}, onCommand() {},
    }));
    for (const label of ["我没懂", "举个例子", "讲快点", "讲细点"]) expect(html).toContain(label);
    for (const legacy of ["分支栈为空", 'data-command-kind="branch"', 'data-command-kind="return"', 'data-command-kind="skip"']) expect(html).not.toContain(legacy);
  });

  it.each([{ disabled: true }, { busyKind: "example" }, { rereadBusy: true }] as const)("keeps action locking: %j", state => {
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: false, onAskExplanation() {}, onCommand() {}, ...state,
    }));
    expect((html.match(/<button[^>]*disabled/g) ?? []).length).toBe(4);
  });

  it("keeps conflict recovery visible and suppresses unusable rewrite actions without an assistant", () => {
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: true, onCommand() {}, onReread() {},
      conflict: { ok: false, conflict: "stale_content_version", message: "content changed", currentContentVersion: 3 },
    }));
    expect(html).toContain("我没懂");
    expect(html).not.toContain("举个例子");
    expect(html).not.toContain("讲快点");
    expect(html).toContain('data-command-conflict="stale_content_version"');
    expect(html).toContain("重新读取教学内容");
    expect(html).not.toContain("force overwrite");
  });

  it("does not surface English UUID why stubs as a delivered explanation", () => {
    const stub = `Why this block (text): revisit block ${BID}.`;
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: false, whyAvailable: true, onCommand() {}, assist: { kind: "why", summary: stub },
    }));
    expect(html).toContain("讲细点");
    expect(html).not.toContain(stub);
    expect(html).not.toContain('data-command-assist="why"');
  });

  it("prepares actual contextual requests without rewriting or skipping the current lesson", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div"), root = createRoot(host);
    const ask = vi.fn(), command = vi.fn();
    try {
      await act(async () => root.render(createElement(BlockCommandsBarView, {
        blockId: BID, returnDisabled: false, onCommand: command, onAskExplanation: ask,
        explanationContext: { activityId: BID, contentVersion: 2, fragment: "当前单元原文" },
      })));
      for (const button of host.querySelectorAll<HTMLButtonElement>("button")) await act(async () => button.click());
      expect(ask).toHaveBeenCalledTimes(4);
      expect(ask.mock.calls.every(call => String(call[0]).includes("当前单元原文"))).toBe(true);
      expect(command).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); }
  });
});
