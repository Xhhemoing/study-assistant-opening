import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TeachingCommandConflict } from "@aistudy/contracts";
import {
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
  it("renders all kinds, disables return when stack empty, skip honesty, no force overwrite", () => {
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
    for (const kind of TEACHING_COMMAND_KINDS) {
      expect(html).toContain(`data-command-kind="${kind}"`);
    }
    expect(html).toContain("data-skip-honesty");
    expect(html).toContain(SKIP_HONESTY_COPY);
    expect(html).toContain('data-command-assist="why"');
    expect(html).toContain("不改写正文");
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
