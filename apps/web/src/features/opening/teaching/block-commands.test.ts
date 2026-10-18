import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TeachingCommandConflict } from "@aistudy/contracts";
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
    expect(teachingCommandConflictLabel("stale_content_version")).toMatch(/重新拉取/);
    expect(SKIP_HONESTY_COPY).toMatch(/不会记为答错/);
  });

  it("mint clientKey length >= 8", () => {
    expect(newTeachingCommandClientKey().length).toBeGreaterThanOrEqual(8);
  });
});

describe("BlockCommandsBarView", () => {
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
    expect(html).toContain("学习路径已更新。");
    expect(html).toMatch(/<details[^>]*><summary[^>]*>技术信息<\/summary>[\s\S]*?path=3[\s\S]*?<\/details>/);
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
    expect(html).toContain("重新拉取教学内容");
    expect(html).toContain("不会提供「强制覆盖」");
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
