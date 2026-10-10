import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { isSourceSelectable, SourcePageControls } from "./source-page-controls";

const COURSE_MEMBER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const WS = "55555555-5555-4555-8555-555555555555";

function source(id: string, name: string): SourceRecord {
  return {
    id,
    workspaceId: WS,
    name,
    mime: "application/pdf",
    bytes: 1,
    sha256: "ab".repeat(32),
    version: 0,
    uploadState: "uploaded",
    parseState: "ready",
    error: null,
    createdAt: "2026-10-10T00:00:00.000Z",
  };
}

describe("source page controls", () => {
  it("only selects uploaded sources whose parsing is ready", () => {
    const row = (uploadState: "uploaded" | "pending", parseState: "ready" | "running") => ({
      uploadState,
      parseState,
    });
    expect(isSourceSelectable(row("uploaded", "ready"))).toBe(true);
    expect(isSourceSelectable(row("uploaded", "running"))).toBe(false);
    expect(isSourceSelectable(row("pending", "ready"))).toBe(false);
  });

  it("with membershipSourceIds defaults to course members and offers workspace expand", () => {
    const html = renderToStaticMarkup(createElement(SourcePageControls, {
      sources: [source(COURSE_MEMBER, "课程讲义.pdf"), source(OTHER, "工作区笔记.pdf")],
      selectedSourceIds: [],
      currentPage: "",
      onSelectedSourceIdsChange: () => undefined,
      onCurrentPageChange: () => undefined,
      membershipSourceIds: new Set([COURSE_MEMBER]),
    }));
    expect(html).toContain("课程讲义.pdf");
    expect(html).toContain("显示工作区其他材料");
    expect(html).not.toContain("工作区笔记.pdf");
  });

  it("without membershipSourceIds lists all ready workspace sources", () => {
    const html = renderToStaticMarkup(createElement(SourcePageControls, {
      sources: [source(COURSE_MEMBER, "课程讲义.pdf"), source(OTHER, "工作区笔记.pdf")],
      selectedSourceIds: [],
      currentPage: "",
      onSelectedSourceIdsChange: () => undefined,
      onCurrentPageChange: () => undefined,
    }));
    expect(html).toContain("课程讲义.pdf");
    expect(html).toContain("工作区笔记.pdf");
    expect(html).not.toContain("显示工作区其他材料");
  });
});
