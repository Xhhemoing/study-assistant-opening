import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { SourceReader } from "./source-reader";

const record = { id: "11111111-1111-4111-8111-111111111111", name: "讲义.pdf", mime: "application/pdf", version: 2, uploadState: "uploaded", parseState: "ready" } as SourceRecord;

describe("dedicated material reader", () => {
  it("opens the requested original as the only default reading view and keeps extracted text on demand", () => {
    const html = renderToStaticMarkup(createElement(SourceReader, { record, requestedVersion: 0, page: 3, onClose: () => {} }));
    expect(html).toContain("<dialog");
    expect(html).toContain("返回");
    expect(html).toContain("version=0");
    expect(html).toContain("#page=3");
    expect(html).toContain("不是当前版本 v2");
    expect(html).toContain("请求定位：第 3 页");
    expect(html).toContain("无法同步确认当前显示页");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-label="解析正文"');
    expect(html).not.toContain("上传材料");
  });
  it("keeps media and slide citation positions explicit when the preview cannot synchronize them", () => {
    const html = renderToStaticMarkup(createElement(SourceReader, { record, requestedVersion: 2, startMs: 65000, slideLabel: "A-1", onClose: () => {} }));
    expect(html).toContain("幻灯片 A-1");
    expect(html).toContain("1:05");
    expect(html).toContain("尚不能同步确认该位置");
  });
  it("keeps retryable parse failures actionable without pretending the original failed to upload", () => {
    const html = renderToStaticMarkup(createElement(SourceReader, { record: { ...record, parseState: "failed", error: { code: "PARSE_FAILED", message: "解析失败", retryable: true } }, requestedVersion: 2, onClose: () => {}, onRetry: async () => {} }));
    expect(html).toContain("解析失败");
    expect(html).toContain("重新解析");
    expect(html).toContain("<iframe");
  });
  it("starts reading extracted content for parsed formats without an inline original viewer", () => {
    const html = renderToStaticMarkup(createElement(SourceReader, { record: { ...record, name: "slides.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }, requestedVersion: 2, onClose: () => {} }));
    expect(html).toContain('aria-label="解析正文"');
    expect(html).toContain("原件信息");
    expect(html).toContain("提问与笔记");
    expect(html).not.toContain("<iframe");
  });

});
