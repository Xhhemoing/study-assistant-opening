import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { createOpeningApi } from "../client/api";
import { InboxPanel } from "./inbox-panel";

function source(id: string, name: string): SourceRecord {
  return { id, name, workspaceId: "workspace", mime: "application/pdf", bytes: 13500904,
    sha256: "ab".repeat(32), version: 0, uploadState: "uploaded", parseState: "ready", error: null,
    createdAt: "2026-10-03T01:00:00.000Z" };
}
const api = createOpeningApi();
const onChanged = async () => {};
const sources = [source("1", "Visible.pdf"), source("2", "Hidden.pdf")];

describe("inbox material collection rendering", () => {
  it.each([true, false, undefined])("shows a partial warning and offers re-parse only with explicit retryable=true (%s)", retryable => {
    const partial = { ...source("partial", "Partial.pdf"), error: { code: "PARSE_PARTIAL", message: "第 2 页识别质量低", retryable } };
    const html = renderToStaticMarkup(createElement(InboxPanel, { api, sources: [partial], onChanged }));
    expect(html).toContain("第 2 页识别质量低");
    expect(html.includes("重新解析")).toBe(retryable === true);
    expect(html).toContain("可以用于提问");
  });
  it("renders only the visible page without treating the full collection as empty", () => {
    const html = renderToStaticMarkup(createElement(InboxPanel, { api, sources, onChanged, visibleSources: [sources[0]!] }));
    expect(html).toContain("Visible.pdf");
    expect(html).not.toContain("Hidden.pdf");
    expect(html).not.toContain("还没有材料");
    expect(html).toContain("PDF");
    expect(html).toContain("12.9 MB · 2026-10-03");
    expect(html).toContain("添加资料");
    expect(html).not.toContain("拖入文件到这里，或点击选择");
    expect(html).toContain("可以用于提问");
  });
  it("keeps a single working upload dropzone inside the empty library action", () => {
    const html = renderToStaticMarkup(createElement(InboxPanel, { api, sources: [], onChanged }));
    expect(html).toContain("拖入文件到这里，或点击选择");
    expect(html).toContain("还没有材料");
    expect(html.match(/type="file"/g)).toHaveLength(1);
  });
  it("renders accessible stable checkboxes for the selected page and accepts course metadata", () => {
    const html = renderToStaticMarkup(createElement(InboxPanel, { api, sources, onChanged,
      visibleSources: [sources[0]!], selectedIds: new Set(["1"]), onToggle: () => {}, selectionDisabled: true,
      renderMetadata: () => createElement("p", null, "微积分 · 核心教材") }));
    expect(html).toContain('aria-label="选择材料 Visible.pdf"');
    expect(html).toContain('checked=""');
    expect(html).toContain('disabled=""');
    expect(html).toContain("微积分 · 核心教材");
    expect(html).not.toContain("Hidden.pdf");
  });
  it("distinguishes no filter matches from an empty library", () => {
    const html = renderToStaticMarkup(createElement(InboxPanel, { api, sources, onChanged, visibleSources: [] }));
    expect(html).toContain("没有匹配的材料");
    expect(html).not.toContain("还没有材料");
  });
  it("preserves the existing assistant name filter when no page is supplied", () => {
    const html = renderToStaticMarkup(createElement(InboxPanel, { api, sources, onChanged, filter: "hidden" }));
    expect(html).toContain("Hidden.pdf");
    expect(html).not.toContain("Visible.pdf");
  });

  it("exposes a delete shortcut on failed source rows while keeping manage", () => {
    const failed: SourceRecord = {
      ...source("3", "Broken.pdf"),
      parseState: "failed",
      error: { code: "PARSE_FAILED", message: "解析失败", retryable: true },
    };
    const html = renderToStaticMarkup(createElement(InboxPanel, {
      api, sources: [failed, sources[0]!], onChanged, visibleSources: [failed, sources[0]!],
    }));
    expect(html).toContain("Broken.pdf");
    expect(html).toContain("删除");
    expect(html).toContain("管理材料");
    // ready row still has 管理材料 but the shortcut button text is only on failed
    expect(html).toContain("Visible.pdf");
  });

});

describe("inbox pending retry without local bytes", () => {
  it("keeps delete shortcut on pending rows and surfaces re-select copy helper", () => {
    const pending: SourceRecord = {
      ...source("9", "Stuck.pdf"),
      uploadState: "pending",
      parseState: "not_started",
    };
    const html = renderToStaticMarkup(createElement(InboxPanel, {
      api, sources: [pending], onChanged, visibleSources: [pending],
    }));
    expect(html).toContain("Stuck.pdf");
    expect(html).toContain("重试上传");
    expect(html).toContain("删除");
  });
});

describe("inbox upload course association helpers", () => {
  it("accepts optional courseId without forcing membership UI chrome", () => {
    const html = renderToStaticMarkup(createElement(InboxPanel, {
      api, sources, onChanged, courseId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(html).toContain("Visible.pdf");
    expect(html).not.toContain("127.0.0.1:9000");
  });
});

it("pins a processing material once and retains selection, management and aged-queue deletion", () => {
  const queued = { ...source("queued", "Processing.pdf"), parseState: "queued" as const };
  const html = renderToStaticMarkup(createElement(InboxPanel, { api, sources: [queued], onChanged, selectedIds: new Set([queued.id]), onToggle: () => {}, onAssign: () => {}, renderMetadata: () => createElement("span", null, "关联课程") }));
  expect(html).toContain('aria-label="材料处理任务"');
  expect(html).toContain("原件已保存，解析排队中");
  expect(html).toContain("阅读已保存原件");
  expect(html).toContain("管理材料");
  expect(html).toContain("归入课程");
  expect(html).toContain("删除");
  expect(html).toContain("关联课程");
  expect(html).toContain('aria-label="选择材料 Processing.pdf"');
  expect(html).toContain('checked=""');
  expect(html.match(/<h3/g)).toHaveLength(1);
  expect(html).not.toContain("<progress");
});
