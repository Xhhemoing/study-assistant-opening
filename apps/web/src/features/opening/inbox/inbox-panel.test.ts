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
  it("renders only the visible page without treating the full collection as empty", () => {
    const html = renderToStaticMarkup(createElement(InboxPanel, { api, sources, onChanged, visibleSources: [sources[0]!] }));
    expect(html).toContain("Visible.pdf");
    expect(html).not.toContain("Hidden.pdf");
    expect(html).not.toContain("还没有材料");
    expect(html).toContain("PDF · 12.9 MB · 2026-10-03");
    expect(html).toContain("可以用于提问");
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
});
