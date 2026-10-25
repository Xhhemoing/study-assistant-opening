import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./block-commands", async () => {
  const actual = await vi.importActual<typeof import("./block-commands")>("./block-commands");
  return {
    ...actual,
    BlockCommands: (props: {
      blockId: string;
      contentVersion: number;
      pathVersion?: number;
      returnDisabled: boolean;
      whyAvailable?: boolean;
    }) =>
      createElement("div", {
        "data-testid": "block-commands-mock",
        "data-block-id": props.blockId,
        "data-content-version": String(props.contentVersion),
        "data-path-version": String(props.pathVersion ?? ""),
        "data-return-disabled": String(props.returnDisabled),
        "data-why-available": String(Boolean(props.whyAvailable)),
      }),
  };
});

import type { OpeningApi } from "../client/api";
import {
  TeachingBlockItem,
  teachingBlockItemClassName,
} from "./teaching-block-item";

const BID = "44444444-4444-4444-8444-444444444444";
const AID = "11111111-1111-4111-8111-111111111111";

const block = {
  blockId: BID,
  position: 0,
  blockType: "text" as const,
  role: "teach" as const,
  content: { text: "共享块渲染正文" },
};

const noopApi = {} as OpeningApi;

function renderItem(
  overrides: Partial<Parameters<typeof TeachingBlockItem>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(TeachingBlockItem, {
      block,
      focusStatus: "current",
      schemaVersion: "1",
      sourceRefs: [],
      showCommands: true,
      activityId: AID,
      contentVersion: 3,
      pathVersion: 2,
      returnDisabled: true,
      whyAvailable: false,
      api: noopApi,
      onSuccess: () => undefined,
      onConflict: () => undefined,
      onReread: () => undefined,
      ...overrides,
    }),
  );
}

describe("teachingBlockItemClassName", () => {
  it("rings current, dims past/skipped, plain upcoming", () => {
    expect(teachingBlockItemClassName("current")).toContain("ring-2");
    expect(teachingBlockItemClassName("past")).toContain("opacity-90");
    expect(teachingBlockItemClassName("skipped")).toContain("opacity-90");
    expect(teachingBlockItemClassName("upcoming")).toBe("space-y-1");
  });
});

describe("TeachingBlockItem", () => {
  it("wires the same focus attrs + BlockRenderer + BlockCommands for any focus status", () => {
    for (const status of ["past", "skipped", "current", "upcoming"] as const) {
      const html = renderItem({ focusStatus: status });
      expect(html).toContain(`data-teaching-block-focus="${status}"`);
      expect(html).toContain(`data-block-id="${BID}"`);
      expect(html).toContain("共享块渲染正文");
      expect(html).toContain('data-testid="block-commands-mock"');
      expect(html).toContain('data-content-version="3"');
      expect(html).toContain('data-path-version="2"');
      expect(html).toContain('data-return-disabled="true"');
      expect(html).toContain('data-why-available="false"');
    }
  });

  it("hides commands when showCommands is false (completed activity)", () => {
    const html = renderItem({ showCommands: false, focusStatus: "past" });
    expect(html).toContain('data-teaching-block-focus="past"');
    expect(html).toContain("共享块渲染正文");
    expect(html).not.toContain('data-testid="block-commands-mock"');
  });

  it("offers paragraph saving and continuing with that paragraph's own block anchor", () => {
    const html = renderItem({ showCommands: false, explanationContext: { activityId: AID, blockId: AID, contentVersion: 3 }, onAskExplanation() {} });
    expect(html).toContain(`data-anchor="${BID}"`);
    expect(html).toContain("补充解释");
    expect(html).toContain("存为笔记");
    expect(html).toContain("做成卡片");
    expect(html).toContain("继续问");
    expect(renderItem({ block: { ...block, blockType: "question", role: "prompt", content: { stem: "题目", answer: "答案", hints: [] } }, showCommands: false, explanationContext: { activityId: AID }, onAskExplanation() {} })).not.toContain("data-anchor");
  });
});
