import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { sourceDownloadHref, sourceViewerCopy, SourceViewer } from "./source-viewer";

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
  it("pins the requested source version and explains a mismatch", () => {
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
          url: "https://minio.local/signed",
          expiresAt: "2026-09-21T00:15:00.000Z",
          version: 0,
          currentVersion: 2,
          versionMismatch: true,
        },
      }),
    );
    expect(html).toContain("原件已保存，解析失败");
    expect(html).toContain("href=\"https://minio.local/signed\"");
    expect(html).toContain("v0");
    expect(html).toContain("不是当前版本");
  });
});
