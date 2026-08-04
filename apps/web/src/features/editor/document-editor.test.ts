import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentLoadError } from "./document-editor";
import { documentToDraft, resolveEditorSaveResult } from "./document-editor-model";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BacklinksPanel } from "./backlinks-panel";
import { PropertiesPanel } from "./properties-panel";
import { ReadOnlyPropertiesPanel } from "./read-only-properties-panel";
import { RelationAuthoringPanel } from "./relation-authoring-panel";

describe("document editor recovery", () => {
  it("keeps local edits made while a save request is in flight", () => {
    const savedDocument = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "服务器标题",
      lifecycle: "scratch",
      currentRevisionNumber: 2,
      blocks: [{
        id: "22222222-2222-4222-8222-222222222222",
        type: "paragraph",
        position: 0,
        content: { blockNoteContent: "服务器内容" },
      }],
    };
    const localDraft = {
      ...documentToDraft(savedDocument),
      title: "保存期间的新标题",
      updatedAt: "2026-08-04T00:00:02.000Z",
    };

    expect(resolveEditorSaveResult(savedDocument, localDraft, 1, 2)).toEqual({
      draft: localDraft,
      hasUnsavedChanges: true,
    });
    expect(resolveEditorSaveResult(savedDocument, localDraft, 1, 1)).toEqual({
      draft: documentToDraft(savedDocument),
      hasUnsavedChanges: false,
    });
  });

  it("exposes a retry action when the document cannot load", () => {
    const html = renderToStaticMarkup(createElement(DocumentLoadError, {
      message: "暂时无法读取这篇笔记，请稍后重试。",
      onRetry: () => undefined,
    }));

    expect(html).toContain('role="alert"');
    expect(html).toContain("重试");
  });

  it("renders the server-backed tags panel with loading and recovery states", () => {
    const html = renderToStaticMarkup(createElement(PropertiesPanel, {
      documentId: "11111111-1111-4111-8111-111111111111",
    }));

    expect(html).toContain("正在读取标签...");
    expect(html).toContain('role="status"');
    const panelSource = readFileSync(resolve(import.meta.dirname, "properties-panel.tsx"), "utf8");
    expect(panelSource).toContain('role="alert"');
    expect(panelSource).toContain("重试读取标签");
    expect(panelSource).toContain("disabled={pending}");
    expect(panelSource).not.toContain("StudyDataProvider");
  });

  it("renders relation authoring with loading, retry, and pending controls", () => {
    const html = renderToStaticMarkup(createElement(RelationAuthoringPanel, {
      documentId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(html).toContain("正在读取关联...");
    expect(html).toContain('role="status"');
    const panelSource = readFileSync(resolve(import.meta.dirname, "relation-authoring-panel.tsx"), "utf8");
    expect(panelSource).toContain('role="alert"');
    expect(panelSource).toContain("重试读取关联");
    expect(panelSource).toContain("disabled={pending}");
    expect(panelSource).toContain("创建关联");
  });

  it("renders read-only properties with loading and retry states", () => {
    const html = renderToStaticMarkup(createElement(ReadOnlyPropertiesPanel, {
      documentId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(html).toContain("正在读取属性...");
    expect(html).toContain('role="status"');
    const panelSource = readFileSync(resolve(import.meta.dirname, "read-only-properties-panel.tsx"), "utf8");
    expect(panelSource).toContain('role="alert"');
    expect(panelSource).toContain("重试读取属性");
    expect(panelSource).not.toContain("setProperty");
  });

  it("renders the backlinks panel with API-driven recovery states", () => {
    const html = renderToStaticMarkup(createElement(BacklinksPanel, {
      documentId: "11111111-1111-4111-8111-111111111111",
    }));

    expect(html).toContain("正在读取链接...");
    expect(html).toContain('role="status"');
    const panelSource = readFileSync(resolve(import.meta.dirname, "backlinks-panel.tsx"), "utf8");
    expect(panelSource).toContain('role="alert"');
    expect(panelSource).toContain("重试读取链接");
    expect(panelSource).toContain("链接目标已失效");
    expect(panelSource).toContain("encodeURIComponent(source.documentId)");
    expect(html).not.toContain("/library/null");
  });
});
