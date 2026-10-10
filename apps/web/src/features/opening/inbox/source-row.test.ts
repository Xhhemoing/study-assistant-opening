import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SourceRow } from "./source-row";

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
    },
    onAssign: () => {},
    onManage: () => {},
  }));
  expect(html).toContain("归入课程");
  expect(html).toContain("管理材料");
});
