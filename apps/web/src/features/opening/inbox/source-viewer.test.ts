import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { buildSourceDownloadView, citationChipLabel, parseSourceViewerSearchParams, sourceDownloadHref, sourceViewerCopy, sourceViewerHref, SourceViewer } from "./source-viewer";

const record = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  name: "notes.pdf",
  mime: "application/pdf",
  bytes: 8,
  sha256: "ab".repeat(32),
  version: 2,
  uploadState: "uploaded",
  parseState: "failed",
  error: { code: "PARSE", message: "parser failed" },
  createdAt: "2026-09-21T00:00:00.000Z",
} satisfies SourceRecord;

describe("source viewer download link", () => {
  it("shows the latest processing state while preserving the pinned download version", () => {
    const html = renderToStaticMarkup(createElement(SourceViewer, {
      record: { ...record, parseState: "running" },
      latestRecord: { ...record, parseState: "ready", version: 2 },
      requestedVersion: 2,
      download: buildSourceDownloadView(record.id, 2, 2),
    }));
    expect(html).toContain("可以用于提问");
    expect(html).not.toContain("正在解析");
    expect(html).toContain("打开原件 v2");
    expect(html).toContain(`href="${sourceDownloadHref(record.id, 2)}"`);
    expect(html).not.toContain("127.0.0.1:9000");
  });
  it("does not apply a newer version's ready status to a pinned old original", () => {
    const html = renderToStaticMarkup(createElement(SourceViewer, {
      record: { ...record, parseState: "failed" },
      latestRecord: { ...record, parseState: "ready", version: 3 },
      requestedVersion: 2,
      download: buildSourceDownloadView(record.id, 2, 2),
    }));
    expect(html).not.toContain("可以用于提问");
    expect(html).toContain("不是当前版本 v3");
  });
  it("respects a newer current version returned by the download endpoint", () => {
    const html = renderToStaticMarkup(createElement(SourceViewer, {
      record: { ...record, parseState: "ready" }, requestedVersion: 2,
      download: { ...buildSourceDownloadView(record.id, 2, 3), versionMismatch: true },
    }));
    expect(html).toContain("不是当前版本 v3");
    expect(html).not.toContain("可以用于提问");
  });
  it("pins the requested source version and never opens MinIO hosts", () => {
    expect(sourceDownloadHref(record.id, 0)).toBe(
      `/api/opening/sources/${record.id}/download?version=0`,
    );
    expect(sourceViewerCopy({ requestedVersion: 0, currentVersion: 2, versionMismatch: true })).toContain(
      "不是当前版本",
    );
    const html = renderToStaticMarkup(
      createElement(SourceViewer, {
        record,
        requestedVersion: 0,
        download: {
          // Even if a caller mistakenly passes a MinIO URL, the anchor must stay same-origin.
          url: "https://minio.local/signed",
          expiresAt: "2026-09-21T00:15:00.000Z",
          version: 0,
          currentVersion: 2,
          versionMismatch: true,
        },
      }),
    );
    expect(html).toContain("这是历史版本");
    expect(html).not.toContain("可以用于提问");
    expect(html).toContain(`href="${sourceDownloadHref(record.id, 0)}"`);
    expect(html).not.toContain("https://minio.local/signed");
    expect(html).not.toContain("127.0.0.1:9000");
    expect(html).toContain("v0");
    expect(html).toContain("不是当前版本");
  });
});

describe("source viewer deep-link (cite Package D)", () => {
  it("builds an in-app viewer href with version and page", () => {
    expect(sourceViewerHref(record.id, 2, { page: 3 })).toBe(
      `/opening/library?tab=materials&source=${record.id}&version=2&page=3`,
    );
    expect(sourceViewerHref(record.id, 1, { slideLabel: "A-1", startMs: 65000 })).toContain("slide=A-1");
    expect(sourceViewerHref(record.id, 1, { startMs: 65000 })).toContain("startMs=65000");
  });

  it("parses viewer search params and rejects invalid source ids", () => {
    expect(parseSourceViewerSearchParams({
      source: record.id,
      version: "2",
      page: "3",
    })).toEqual({ sourceId: record.id, version: 2, page: 3 });
    expect(parseSourceViewerSearchParams({ source: "not-a-uuid", version: "1" })).toBeNull();
  });

  it("builds a readable chip label from source name and page", () => {
    expect(citationChipLabel({
      label: "source uuid v1 page 3",
      page: 3,
      sourceName: "notes.pdf",
    })).toBe("notes.pdf · 第 3 页");
    expect(citationChipLabel({
      label: "fallback label",
      slideLabel: "A-1",
    })).toBe("幻灯片 A-1");
    expect(citationChipLabel({ label: "only label" })).toBe("only label");
  });

  it("honors page on open-original download href and viewer copy", () => {
    const html = renderToStaticMarkup(createElement(SourceViewer, {
      record,
      requestedVersion: 2,
      download: buildSourceDownloadView(record.id, 2, 2, 4),
      page: 4,
    }));
    expect(html).toContain(`href="${sourceDownloadHref(record.id, 2, 4)}"`);
    expect(html).toContain("#page=4");
    expect(html).toContain("第 4 页");
    expect(sourceViewerCopy({
      requestedVersion: 2,
      currentVersion: 2,
      versionMismatch: false,
      page: 4,
    })).toContain("第 4 页");
  });
});
