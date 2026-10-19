import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceContentBody, loadSourceContent, sourceContentExplanation } from "./source-content";
const content = { sourceId: "11111111-1111-4111-8111-111111111111", version: 0, currentVersion: 0, page: 2, pages: [1,2], pageKind: "physical" as const, readablePages: 1, characters: 30, text: "<script>alert(1)</script>\nA formula", truncated: true };
describe("parsed source content", () => {
  it("renders extracted text safely with exact page/version and truncation", () => {
    const html = renderToStaticMarkup(createElement(SourceContentBody, { content }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("物理页 2");
    expect(html).toContain("v0");
    expect(html).toContain("截断");
  });
  it("does not substitute success copy for an empty physical page", () => {
    const html = renderToStaticMarkup(createElement(SourceContentBody, { content: { ...content, text: "", truncated: false } }));
    expect(html).toContain("未提取到正文");
    expect(html).toContain("OCR");
  });
  it("pins requests and propagates unavailable content instead of an empty success", async () => {
    let requested = "";
    const value = await loadSourceContent(content.sourceId, 0, 2, async url => { requested = String(url); return Response.json(content); });
    expect(requested).toBe(`/api/opening/sources/${content.sourceId}/content?version=0&page=2`);
    expect(value.text).toBe(content.text);
    await expect(loadSourceContent(content.sourceId, 0, undefined, async () => new Response(null, { status: 409 }))).rejects.toThrow();
  });
  it.each([
    { sourceId: "22222222-2222-4222-8222-222222222222" },
    { version: 1 }, { page: 1 },
  ])("rejects body identity or locator drift rather than displaying the wrong evidence: %j", async drift => {
    await expect(loadSourceContent(content.sourceId, 0, 2, async () => Response.json({ ...content, ...drift }))).rejects.toThrow("不一致");
  });

  it("names the specified physical page and does not offer current-version analysis for old, empty, or section evidence", () => {
    const explanation = sourceContentExplanation(content);
    expect(explanation?.label).toBe("解释第 2 页");
    expect(Object.fromEntries(new URL(explanation!.href, "https://study.test").searchParams)).toMatchObject({ source: content.sourceId, version: String(content.version), page: "2", purpose: "material_read" });
    expect(sourceContentExplanation({ ...content, currentVersion: 1 })).toBeNull();
    expect(sourceContentExplanation({ ...content, text: "  " })).toBeNull();
    expect(sourceContentExplanation({ ...content, pageKind: "section" })).toBeNull();
    expect(sourceContentExplanation({ ...content, page: null })).toBeNull();
  });

});
