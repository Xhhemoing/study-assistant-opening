// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TeachingCommandConflict, TeachingCommandResponse, TeachingCommandSuccess } from "@aistudy/contracts";
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
    const why = () => host.querySelector<HTMLButtonElement>('[data-command-kind="why"]')!;
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
    const why = () => host.querySelector<HTMLButtonElement>('[data-command-kind="why"]')!;
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
    for (const action of ["存为笔记", "做成卡片", "继续问"]) expect(html).toContain(action);
  });
  it("keeps a confused acknowledgement separate from an actual supplemental explanation", () => {
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: false, assist: { kind: "confused", summary: "已记下这里需要讲清楚。" },
      explanationContext: { activityId: BID, contentVersion: 2 }, onAskExplanation() {}, onCommand() {},
    }));
    expect(html).toContain("已记下这里需要讲清楚。");
    expect(html).not.toContain("存为笔记");
  });
  it("keeps all auxiliary actions in one initially collapsed native disclosure", () => {
    const html = renderToStaticMarkup(
      createElement(BlockCommandsBarView, {
        blockId: BID,
        returnDisabled: false,
        whyAvailable: true,
        onCommand: () => undefined,
      }),
    );
    const help = html.match(/<details[^>]*data-command-help="true"[^>]*>([\s\S]*?)<\/details>/);
    expect(help).not.toBeNull();
    expect(help![0].split(">")[0]).not.toMatch(/\bopen(?:=|\s|$)/);
    expect(help![1]).toMatch(/<summary[^>]*>[\s\S]*?学习帮助[\s\S]*?<\/summary>/);
    expect(help![1]).toContain('role="group"');
    expect(help![1]).toContain('aria-label="当前学习单元帮助"');
    for (const kind of TEACHING_COMMAND_KINDS) {
      expect(help![1]).toContain(`data-command-kind="${kind}"`);
    }
    expect(help![1]).toContain(SKIP_HONESTY_COPY);
    expect(html).not.toContain('role="toolbar"');
  });

  it("keeps help results and recovery visible outside the collapsed disclosure", () => {
    const html = renderToStaticMarkup(
      createElement(BlockCommandsBarView, {
        blockId: BID,
        returnDisabled: true,
        whyAvailable: true,
        assist: { kind: "why", summary: "先比较两组向量的方向。" },
        conflict: {
          ok: false,
          conflict: "stale_path_version",
          message: "学习路径已更新。",
          currentPathVersion: 3,
        },
        onCommand: () => undefined,
        onReread: () => undefined,
      }),
    );
    const helpEnd = html.indexOf("</details>");
    expect(html.indexOf('data-command-assist="why"')).toBeGreaterThan(helpEnd);
    expect(html.indexOf('data-command-conflict="stale_path_version"')).toBeGreaterThan(helpEnd);
    expect(html.indexOf('data-command-reread="true"')).toBeGreaterThan(helpEnd);
    expect(html).toContain("学习路径已更新");
    expect(html).not.toContain("path=3");
  });

  it.each([
    { disabled: true },
    { busyKind: "example" },
    { rereadBusy: true },
  ] as const)("preserves command locking while help is available: %j", (state) => {
    const html = renderToStaticMarkup(
      createElement(BlockCommandsBarView, {
        blockId: BID,
        returnDisabled: false,
        whyAvailable: true,
        onCommand: () => undefined,
        ...state,
      }),
    );
    for (const kind of TEACHING_COMMAND_KINDS) {
      expect(html).toMatch(new RegExp(`data-command-kind="${kind}"[^>]*disabled`));
    }
    expect(html).toContain("学习帮助");
  });

  it("can open the commands inside an explicitly selected parent help panel", () => {
    const html = renderToStaticMarkup(
      createElement(BlockCommands, {
        activityId: "activity-1",
        blockId: BID,
        contentVersion: 2,
        returnDisabled: false,
        compact: true,
        defaultOpen: true,
      }),
    );
    expect(html).toMatch(/<details[^>]*data-command-help="true"[^>]*open=""/);
    expect(html).toContain('data-command-kind="skip"');
  });

  it("renders kinds (why hidden by default), disables return when stack empty, skip honesty, no force overwrite", () => {
    const onCommand = vi.fn();
    const conflict: TeachingCommandConflict = {
      ok: false,
      conflict: "stale_content_version",
      message: "content_version mismatch",
      currentContentVersion: 3,
      currentPathVersion: 2,
    };
    const html = renderToStaticMarkup(
      createElement(BlockCommandsBarView, {
        blockId: BID,
        returnDisabled: true,
        conflict,
        assist: { kind: "why", summary: "因为矩阵秩反映线性无关行数。" },
        onCommand,
        onReread: () => undefined,
      }),
    );
    expect(html).toContain('data-block-commands="true"');
    expect(html).toContain('data-why-available="false"');
    expect(html).not.toContain('data-command-kind="why"');
    for (const kind of TEACHING_COMMAND_KINDS.filter((k) => k !== "why")) {
      expect(html).toContain(`data-command-kind="${kind}"`);
    }
    expect(html).toContain("data-skip-honesty");
    expect(html).toContain(SKIP_HONESTY_COPY);
    // Stub-era: why assist panel not shown when whyAvailable=false
    expect(html).not.toContain('data-command-assist="why"');
    expect(html).toContain('data-command-conflict="stale_content_version"');
    expect(html).toContain("data-command-reread");
    expect(html).toContain("重新读取教学内容");
    expect(html).not.toContain("data-force-overwrite");
    expect(html).not.toContain("force overwrite");
    expect(html).not.toContain("LWW");
    // return button disabled when stack empty
    expect(html).toMatch(/data-command-kind="return"[^>]*disabled/);
  });

  it("does not surface English UUID why stub as 说明", () => {
    const stub = `Why this block (text): revisit the goal and evidence behind block ${BID}.`;
    const html = renderToStaticMarkup(
      createElement(BlockCommandsBarView, {
        blockId: BID,
        returnDisabled: true,
        whyAvailable: true,
        assist: { kind: "why", summary: stub },
        onCommand: () => undefined,
      }),
    );
    expect(html).toContain('data-command-kind="why"');
    expect(html).not.toContain('data-command-assist="why"');
    expect(html).not.toContain(stub);
    expect(html).not.toContain("Why this block");
  });

  it("enables return when stack not empty", () => {
    const html = renderToStaticMarkup(
      createElement(BlockCommandsBarView, {
        blockId: BID,
        returnDisabled: false,
        onCommand: () => undefined,
      }),
    );
    expect(html).toContain('data-command-kind="return"');
    expect(html).not.toMatch(/data-command-kind="return"[^>]*disabled/);
  });
});
