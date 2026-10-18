import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SourceRow, sourceFormatLabel } from "./source-row";

it.each([
  { name: "lecture.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "DOCX" },
  { name: "lecture.pdf", mime: "application/vnd.custom-very-long-unknown-document-format", label: "PDF" },
  { name: "lecture.verylongcustomextension", mime: "application/vnd.custom-very-long-unknown-document-format", label: "文件" },
  { name: "lecture", mime: "application/octet-stream", label: "文件" },
])("shows a short format label for $name", ({ name, mime, label }) => {
  const format = sourceFormatLabel({ name, mime });
  expect(format).toBe(label);
  expect(format.length).toBeLessThanOrEqual(6);
});

it("makes the material title the primary open action and keeps metadata and management collapsed", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "lecture.pdf",
      mime: "application/pdf",
      bytes: 1024 * 1024,
      createdAt: "2026-10-04T00:00:00.000Z",
      uploadState: "uploaded",
      parseState: "ready",
      error: null,
    },
    onOpen: () => {},
    onAssign: () => {},
    onManage: () => {},
  }));
  expect(html).toMatch(/<h3[^>]*><button[^>]*aria-label="打开资料：lecture.pdf"[^>]*data-source-open="11111111-1111-4111-8111-111111111111"[^>]*>lecture.pdf<\/button><\/h3>/);
  const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0];
  expect(details).toBeDefined();
  expect(details).not.toMatch(/<details\b[^>]*\bopen/);
  expect(details).toContain("更多操作");
  expect(details).toContain("1.0 MB · 2026-10-04");
  expect(details).toContain("归入课程");
  expect(details).toContain("管理材料");
  const visible = html.replace(details!, "");
  expect(visible).toContain("PDF");
  expect(visible).toContain("可以用于提问");
  expect(visible).not.toContain("1.0 MB");
  expect(visible).not.toContain("管理材料");
});

it("keeps failures and retry actions available before expanding management", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "failed.pdf",
      uploadState: "uploaded",
      parseState: "failed",
      error: { code: "PARSE_FAILED", message: "解析失败，请重试", retryable: true },
    },
    onRetry: () => {},
    onDelete: () => {},
  }));
  const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0];
  expect(details).toContain("删除");
  const visible = html.replace(details!, "");
  expect(visible).toContain("解析失败，请重试");
  expect(visible).toContain("重新解析");
});

it("labels parse failure recovery as re-parse", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "failed.pdf",
      mime: "application/pdf",
      bytes: 20,
      createdAt: "2026-10-04T00:00:00.000Z",
      uploadState: "uploaded",
      parseState: "failed",
      error: null,
    },
    onRetry: () => {},
  }));
  expect(html).toContain("重新解析");
});

it("shows delete shortcut for failed parse rows when onDelete is provided", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "failed.pdf",
      mime: "application/pdf",
      bytes: 20,
      createdAt: "2026-10-04T00:00:00.000Z",
      uploadState: "uploaded",
      parseState: "failed",
      error: null,
    },
    onManage: () => {},
    onDelete: () => {},
  }));
  expect(html).toContain("删除");
  expect(html).toContain("管理材料");
});

it("shows delete shortcut for rejected uploads when onDelete is provided", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "rejected.pdf",
      mime: "application/pdf",
      bytes: 20,
      createdAt: "2026-10-04T00:00:00.000Z",
      uploadState: "rejected",
      parseState: "queued",
      error: null,
    },
    onDelete: () => {},
  }));
  expect(html).toContain("删除");
});

it("does not show delete shortcut for ready rows even with onDelete", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "ready.pdf",
      mime: "application/pdf",
      bytes: 20,
      createdAt: "2026-10-04T00:00:00.000Z",
      uploadState: "uploaded",
      parseState: "ready",
      error: null,
    },
    onManage: () => {},
    onDelete: () => {},
  }));
  expect(html).toContain("管理材料");
  expect(html).not.toContain("删除");
});

it("shows delete shortcut for pending upload rows when onDelete is provided", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "stuck.pdf",
      mime: "application/pdf",
      bytes: 20,
      createdAt: "2026-10-04T00:00:00.000Z",
      uploadState: "pending",
      parseState: "not_started",
      error: null,
    },
    onManage: () => {},
    onDelete: () => {},
  }));
  expect(html).toContain("删除");
  expect(html).toContain("管理材料");
  expect(html).toContain("上传未完成");
});

it("hides re-parse when error.retryable is false and shows the stored message", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "lecture.mp3",
      mime: "audio/mpeg",
      bytes: 20,
      createdAt: "2026-10-04T00:00:00.000Z",
      uploadState: "uploaded",
      parseState: "failed",
      error: {
        code: "blocked_not_configured",
        message: "转写服务未配置（需 faster-whisper），原件已保存；配置完成前重试无效。",
        retryable: false,
      },
    },
    onRetry: () => {},
  }));
  expect(html).toContain("转写服务未配置");
  expect(html).not.toContain("重新解析");
});

it("still shows re-parse for retryable parse failures", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "failed.pdf",
      mime: "application/pdf",
      bytes: 20,
      createdAt: "2026-10-04T00:00:00.000Z",
      uploadState: "uploaded",
      parseState: "failed",
      error: { code: "PARSE_FAILED", message: "解析失败", retryable: true },
    },
    onRetry: () => {},
  }));
  expect(html).toContain("重新解析");
});

it("shows assign-to-course shortcut when onAssign is provided", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "ready.pdf",
      mime: "application/pdf",
      bytes: 20,
      createdAt: "2026-10-04T00:00:00.000Z",
      uploadState: "uploaded",
      parseState: "ready",
      error: null,
    },
    onAssign: () => {},
    onManage: () => {},
  }));
  expect(html).toContain("归入课程");
  expect(html).toContain("管理材料");
});

it("shows delete shortcut for unsupported parse rows when onDelete is provided", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "legacy.ppt",
      mime: "application/vnd.ms-powerpoint",
      bytes: 20,
      createdAt: "2026-10-04T00:00:00.000Z",
      uploadState: "uploaded",
      parseState: "unsupported",
      error: null,
    },
    onDelete: () => {},
  }));
  expect(html).toContain("删除");
  expect(html).toContain("原件已保存，暂不能提取文字");
});

it("shows delete shortcut for aged queued parse rows when onDelete is provided", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "slow.pdf",
      mime: "application/pdf",
      bytes: 20,
      // Created well before AGED_QUEUED_MS (3 min) relative to "now" in sourceStatusLabel default Date.now().
      createdAt: "2020-01-01T00:00:00.000Z",
      uploadState: "uploaded",
      parseState: "queued",
      error: null,
    },
    onDelete: () => {},
  }));
  expect(html).toContain("删除");
});

it("does not show delete shortcut for fresh queued rows", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "fresh.pdf",
      mime: "application/pdf",
      bytes: 20,
      createdAt: new Date().toISOString(),
      uploadState: "uploaded",
      parseState: "queued",
      error: null,
    },
    onDelete: () => {},
  }));
  expect(html).not.toContain("删除");
});
